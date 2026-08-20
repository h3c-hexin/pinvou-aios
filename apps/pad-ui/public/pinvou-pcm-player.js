class PinvouPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "clear") {
        this.queue = [];
        this.offset = 0;
        return;
      }
      if (event.data?.type === "push" && event.data.samples) {
        this.queue.push(event.data.samples);
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    let target = 0;
    while (target < output.length && this.queue.length > 0) {
      const current = this.queue[0];
      const available = current.length - this.offset;
      const count = Math.min(output.length - target, available);
      output.set(current.subarray(this.offset, this.offset + count), target);
      target += count;
      this.offset += count;
      if (this.offset >= current.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pinvou-pcm-player", PinvouPcmPlayer);
