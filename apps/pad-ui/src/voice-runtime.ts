export type ContinuousVoiceState = "off" | "requesting" | "listening" | "hearing" | "recognizing";

function rootMeanSquare(samples: Float32Array) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function downsamplePcm16(input: Float32Array, inputRate: number, outputRate = 16_000) {
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let source = start; source < end; source += 1) sum += input[source];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function wavFromPcm(chunks: Int16Array[], sampleRate = 16_000) {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return buffer;
}

export class PcmAudioPlayer {
  private context?: AudioContext;
  private node?: AudioWorkletNode;

  async push(audio: Uint8Array, sampleRate: number) {
    if (!this.context || this.context.sampleRate !== sampleRate) {
      await this.close();
      this.context = new AudioContext({ sampleRate });
      await this.context.audioWorklet.addModule(new URL("./pinvou-pcm-player.js", window.location.href));
      this.node = new AudioWorkletNode(this.context, "pinvou-pcm-player", {
        outputChannelCount: [1],
      });
      this.node.connect(this.context.destination);
    }
    if (this.context.state === "suspended") await this.context.resume();
    const evenLength = audio.byteLength - (audio.byteLength % 2);
    const samples = new Float32Array(evenLength / 2);
    const view = new DataView(audio.buffer, audio.byteOffset, evenLength);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 0x8000;
    }
    this.node?.port.postMessage({ type: "push", samples }, [samples.buffer]);
  }

  clear() {
    this.node?.port.postMessage({ type: "clear" });
  }

  async close() {
    this.node?.disconnect();
    this.node = undefined;
    await this.context?.close();
    this.context = undefined;
  }
}

interface ContinuousVoiceOptions {
  onState: (state: ContinuousVoiceState) => void;
  onSpeechStart: () => void | Promise<void>;
  onUtterance: (audio: ArrayBuffer) => Promise<void>;
  onError: (reason: unknown) => void;
}

export class ContinuousVoiceCapture {
  private options: ContinuousVoiceOptions;
  private context?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode;
  private sink?: GainNode;
  private running = false;
  private speaking = false;
  private processingUtterances = false;
  private noiseFloor = 0.006;
  private speechMs = 0;
  private silenceMs = 0;
  private utteranceMs = 0;
  private prerollMs = 0;
  private preroll: Int16Array[] = [];
  private utterance: Int16Array[] = [];
  private utteranceQueue: ArrayBuffer[] = [];

  constructor(options: ContinuousVoiceOptions) {
    this.options = options;
  }

  async start() {
    if (this.running) return;
    this.options.onState("requesting");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule(new URL("./pinvou-pcm-capture.js", window.location.href));
      this.source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, "pinvou-pcm-capture");
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.node.port.onmessage = (event) => this.handleSamples(event.data);
      this.source.connect(this.node).connect(this.sink).connect(this.context.destination);
      this.running = true;
      this.options.onState("listening");
    } catch (error) {
      await this.stop();
      this.options.onError(error);
      throw error;
    }
  }

  async stop() {
    this.running = false;
    this.speaking = false;
    this.utteranceQueue = [];
    this.node?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close();
    this.context = undefined;
    this.stream = undefined;
    this.source = undefined;
    this.node = undefined;
    this.sink = undefined;
    this.resetUtterance();
    this.options.onState("off");
  }

  private handleSamples(samples: Float32Array) {
    if (!this.running || !this.context) return;
    const duration = (samples.length / this.context.sampleRate) * 1_000;
    const level = rootMeanSquare(samples);
    const threshold = Math.max(0.013, this.noiseFloor * 3.2);
    const voiced = level >= threshold;
    const pcm = downsamplePcm16(samples, this.context.sampleRate);

    if (!this.speaking) {
      this.noiseFloor = this.noiseFloor * 0.985 + Math.min(level, 0.025) * 0.015;
      this.preroll.push(pcm);
      this.prerollMs += duration;
      // Keep enough audio before VAD confirmation to preserve soft initial syllables during barge-in.
      while (this.prerollMs > 640 && this.preroll.length > 1) {
        const removed = this.preroll.shift();
        if (removed) this.prerollMs -= (removed.length / 16_000) * 1_000;
      }
      this.speechMs = voiced ? this.speechMs + duration : 0;
      if (this.speechMs >= 96) {
        this.speaking = true;
        this.utterance = this.preroll.splice(0);
        this.utteranceMs = this.prerollMs;
        this.prerollMs = 0;
        this.silenceMs = 0;
        this.options.onState("hearing");
        try {
          void Promise.resolve(this.options.onSpeechStart()).catch(this.options.onError);
        } catch (error) {
          this.options.onError(error);
        }
      }
      return;
    }

    this.utterance.push(pcm);
    this.utteranceMs += duration;
    this.silenceMs = voiced ? 0 : this.silenceMs + duration;
    if ((this.silenceMs >= 680 && this.utteranceMs >= 420) || this.utteranceMs >= 30_000) {
      const audio = wavFromPcm(this.utterance);
      this.resetUtterance();
      this.utteranceQueue.push(audio);
      this.options.onState("recognizing");
      void this.processUtteranceQueue();
    }
  }

  private async processUtteranceQueue() {
    // ASR is serialized, but microphone capture continues filling the next utterance concurrently.
    if (this.processingUtterances) return;
    this.processingUtterances = true;
    try {
      while (this.running && this.utteranceQueue.length > 0) {
        const audio = this.utteranceQueue.shift();
        if (!audio) continue;
        if (!this.speaking) this.options.onState("recognizing");
        try {
          await this.options.onUtterance(audio);
        } catch (error) {
          this.options.onError(error);
        }
      }
    } finally {
      this.processingUtterances = false;
      if (this.running) this.options.onState(this.speaking ? "hearing" : "listening");
    }
  }

  private resetUtterance() {
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.utteranceMs = 0;
    this.prerollMs = 0;
    this.preroll = [];
    this.utterance = [];
  }
}
