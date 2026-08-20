import net from "node:net";

export class DaemonEventStream {
  constructor({ socketPath, onEvent, onState = () => {}, retryMs = 800 }) {
    this.socketPath = socketPath;
    this.onEvent = onEvent;
    this.onState = onState;
    this.retryMs = retryMs;
    this.socket = undefined;
    this.retryTimer = undefined;
    this.stopped = true;
    this.buffer = "";
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.buffer = "";
  }

  #connect() {
    if (this.stopped) return;
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.once("connect", () => this.onState({ connected: true }));
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const value = JSON.parse(line);
          if (value?.type === "event") this.onEvent(value);
        } catch (error) {
          this.onState({ connected: true, error: `守护进程事件格式错误：${error.message}` });
        }
      }
    });
    const reconnect = (error) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.onState({ connected: false, error: error?.message });
      if (!this.stopped) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          this.#connect();
        }, this.retryMs);
      }
    };
    socket.once("error", reconnect);
    socket.once("close", () => reconnect());
  }
}
