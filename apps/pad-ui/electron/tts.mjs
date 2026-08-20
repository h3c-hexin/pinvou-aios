import crypto from "node:crypto";

import WebSocket from "ws";

const defaultEndpoint = "wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference";

export function spokenText(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " 已省略代码。 ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "链接")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*(?:[-*+] |\d+[.)]\s+)/gm, "")
    .replace(/[>*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class SentenceAssembler {
  constructor({ minimum = 10, maximum = 90 } = {}) {
    this.minimum = minimum;
    this.maximum = maximum;
    this.buffer = "";
  }

  push(delta) {
    this.buffer += delta || "";
    return this.#drain(false);
  }

  flush() {
    return this.#drain(true);
  }

  #drain(final) {
    const sentences = [];
    while (this.buffer) {
      const punctuation = this.buffer.search(/[。！？!?；;\n]/);
      const enough = punctuation >= this.minimum - 1;
      const tooLong = this.buffer.length >= this.maximum;
      if (!final && !enough && !tooLong) break;
      let cut = enough ? punctuation + 1 : Math.min(this.buffer.length, this.maximum);
      if (tooLong && (!enough || cut > this.maximum)) {
        const candidate = this.buffer.slice(0, this.maximum);
        const soft = Math.max(candidate.lastIndexOf("，"), candidate.lastIndexOf(","), candidate.lastIndexOf(" "));
        cut = soft >= this.minimum ? soft + 1 : this.maximum;
      }
      const sentence = spokenText(this.buffer.slice(0, cut));
      this.buffer = this.buffer.slice(cut);
      if (sentence) sentences.push(sentence);
      if (final && this.buffer.length < this.minimum) {
        const remainder = spokenText(this.buffer);
        this.buffer = "";
        if (remainder) sentences.push(remainder);
      }
    }
    return sentences;
  }
}

function taskId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function command(action, id, payload = {}) {
  return JSON.stringify({
    header: { action, task_id: id, streaming: "duplex" },
    payload,
  });
}

export class TokenPlanTtsTurn {
  constructor({
    apiKey,
    endpoint = defaultEndpoint,
    model = "qwen-audio-3.0-tts-plus",
    voice = "longanlingxin",
    onAudio = () => {},
    onState = () => {},
    WebSocketImpl = WebSocket,
  }) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.model = model;
    this.voice = voice;
    this.onAudio = onAudio;
    this.onState = onState;
    this.WebSocketImpl = WebSocketImpl;
    this.id = taskId();
    this.queue = [];
    this.started = false;
    this.finishRequested = false;
    this.closed = false;
    this.socket = undefined;
  }

  start() {
    if (!this.apiKey) throw new Error("未配置 PINVOU_TOKEN_PLAN_API_KEY，无法使用语音合成");
    const socket = new this.WebSocketImpl(this.endpoint, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "user-agent": "pinvou-aios/0.1 dashscope-compatible",
      },
    });
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.on("open", () => {
      socket.send(command("run-task", this.id, {
        task_group: "audio",
        task: "tts",
        function: "SpeechSynthesizer",
        model: this.model,
        parameters: {
          text_type: "PlainText",
          voice: this.voice,
          format: "pcm",
          sample_rate: 24_000,
          volume: 50,
          rate: 1,
          pitch: 1,
          seed: 0,
          type: 0,
        },
        input: {},
      }));
      this.onState({ state: "connecting", model: this.model, voice: this.voice });
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.onAudio(data instanceof Buffer ? data : Buffer.from(data));
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        this.#fail(new Error(`语音合成返回了无效消息：${error.message}`));
        return;
      }
      const event = message?.header?.event;
      if (event === "task-started") {
        this.started = true;
        this.onState({ state: "speaking", model: this.model, voice: this.voice });
        this.#flushQueue();
      } else if (event === "task-finished") {
        this.closed = true;
        this.onState({ state: "finished", model: this.model, voice: this.voice });
        socket.close();
      } else if (event === "task-failed") {
        this.#fail(new Error(message?.header?.error_message || "语音合成失败"));
      }
    });
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => {
      if (!this.closed) this.onState({ state: "stopped", model: this.model, voice: this.voice });
      this.closed = true;
    });
  }

  append(text) {
    if (this.closed || !text) return;
    this.queue.push(text);
    this.#flushQueue();
  }

  finish() {
    if (this.closed) return;
    this.finishRequested = true;
    this.#flushQueue();
  }

  cancel() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.socket?.close();
    this.onState({ state: "stopped", model: this.model, voice: this.voice });
  }

  #flushQueue() {
    if (!this.started || this.closed || this.socket?.readyState !== this.WebSocketImpl.OPEN) return;
    while (this.queue.length > 0) {
      this.socket.send(command("continue-task", this.id, {
        model: this.model,
        task_group: "audio",
        task: "tts",
        function: "SpeechSynthesizer",
        input: { text: this.queue.shift() },
      }));
    }
    if (this.finishRequested) {
      this.finishRequested = false;
      this.socket.send(command("finish-task", this.id, { input: {} }));
    }
  }

  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.socket?.close();
    this.onState({ state: "error", error: error.message, model: this.model, voice: this.voice });
  }
}

export class VoiceOutputGateway {
  constructor({ apiKey, endpoint, voice, onAudio, onState, onFallback = () => {}, TurnImpl = TokenPlanTtsTurn }) {
    this.options = { apiKey, endpoint, voice, onAudio, onState };
    this.onState = onState;
    this.onFallback = onFallback;
    this.TurnImpl = TurnImpl;
    this.turnId = undefined;
    this.turn = undefined;
    this.assembler = new SentenceAssembler();
    this.sentences = [];
    this.audioBytes = 0;
    this.completed = false;
    this.cloudFailed = false;
    this.fallbackSent = false;
  }

  handleEvent(event) {
    const id = event?.data?.turnId;
    if (!id) return;
    if (event.event === "main.turn.accepted" || event.event === "main.turn.started") {
      if (this.turnId !== id) this.#startTurn(id);
      return;
    }
    if (event.event === "main.turn.delta") {
      if (this.turnId !== id) return;
      for (const sentence of this.assembler.push(event.data.delta)) this.#append(sentence);
      return;
    }
    if (event.event === "main.turn.completed") {
      if (this.turnId !== id) return;
      for (const sentence of this.assembler.flush()) this.#append(sentence);
      this.completed = true;
      this.turn?.finish();
      this.#maybeFallback();
      return;
    }
    if (event.event === "main.turn.interrupted" || event.event === "main.turn.failed") {
      if (this.turnId === id) this.cancel();
    }
  }

  cancel() {
    this.turn?.cancel();
    this.turn = undefined;
    this.turnId = undefined;
    this.assembler = new SentenceAssembler();
    this.sentences = [];
    this.audioBytes = 0;
    this.completed = false;
    this.cloudFailed = false;
    this.fallbackSent = false;
  }

  #startTurn(id) {
    this.cancel();
    this.turnId = id;
    this.assembler = new SentenceAssembler();
    this.sentences = [];
    this.audioBytes = 0;
    this.completed = false;
    this.cloudFailed = false;
    this.fallbackSent = false;
    if (!this.options.apiKey) {
      this.cloudFailed = true;
      this.onState({ state: "disabled", error: "未配置 Token Plan TTS 密钥" });
      return;
    }
    this.turn = new this.TurnImpl({
      ...this.options,
      onAudio: (audio) => {
        this.audioBytes += audio?.byteLength || 0;
        this.options.onAudio(audio);
      },
      onState: (state) => {
        if (state.state === "error") {
          this.cloudFailed = true;
          this.onState({ ...state, state: "fallback" });
          this.#maybeFallback();
          return;
        }
        if (state.state === "finished" && this.audioBytes === 0) {
          this.cloudFailed = true;
          this.#maybeFallback();
        }
        this.onState(state);
      },
    });
    try {
      this.turn.start();
    } catch (error) {
      this.onState({ state: "error", error: error.message });
      this.turn = undefined;
    }
  }

  #append(sentence) {
    this.sentences.push(sentence);
    this.turn?.append(sentence);
  }

  #maybeFallback() {
    if (!this.completed || !this.cloudFailed || this.audioBytes > 0 || this.fallbackSent) return;
    const text = this.sentences.join(" ").trim();
    if (!text) return;
    this.fallbackSent = true;
    this.onFallback(text);
  }
}
