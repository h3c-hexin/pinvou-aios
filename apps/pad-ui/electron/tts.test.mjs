import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { SentenceAssembler, TokenPlanTtsTurn, VoiceOutputGateway, spokenText } from "./tts.mjs";

test("Token Plan TTS defaults use a voice supported by qwen-audio-3.0-tts-plus", () => {
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    constructor() {
      super();
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      FakeWebSocket.instance = this;
    }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() {}
  }
  const turn = new TokenPlanTtsTurn({
    apiKey: "test",
    WebSocketImpl: FakeWebSocket,
  });
  turn.start();
  FakeWebSocket.instance.emit("open");
  const request = FakeWebSocket.instance.sent[0].payload;
  assert.equal(request.model, "qwen-audio-3.0-tts-plus");
  assert.equal(request.parameters.voice, "longanlingxin");
  assert.equal(request.parameters.format, "pcm");
  assert.equal(request.parameters.sample_rate, 24_000);
});

test("spokenText removes visual-only markdown while retaining its meaning", () => {
  assert.equal(
    spokenText("## 结果\n- 打开 [控制台](https://example.com)\n```js\nalert(1)\n```"),
    "结果 打开 控制台 已省略代码。",
  );
});

test("SentenceAssembler emits complete short sentences and flushes remainder", () => {
  const assembler = new SentenceAssembler({ minimum: 4, maximum: 30 });
  assert.deepEqual(assembler.push("我正在查询"), []);
  assert.deepEqual(assembler.push("天气。接下来"), ["我正在查询天气。"]);
  assert.deepEqual(assembler.flush(), ["接下来"]);
});

test("VoiceOutputGateway only speaks the matching voice turn", () => {
  const calls = [];
  class FakeTurn {
    constructor() {}
    start() { calls.push("start"); }
    append(value) { calls.push(["append", value]); }
    finish() { calls.push("finish"); }
    cancel() { calls.push("cancel"); }
  }
  const gateway = new VoiceOutputGateway({
    apiKey: "test",
    onAudio() {},
    onState() {},
    TurnImpl: FakeTurn,
  });
  gateway.handleEvent({ event: "main.turn.accepted", data: { turnId: "voice-1" } });
  gateway.handleEvent({ event: "main.turn.delta", data: { turnId: "typed", delta: "不应朗读。" } });
  gateway.handleEvent({ event: "main.turn.delta", data: { turnId: "voice-1", delta: "这是语音回答。" } });
  gateway.handleEvent({ event: "main.turn.completed", data: { turnId: "voice-1" } });
  assert.deepEqual(calls, ["start", ["append", "这是语音回答。"], "finish"]);
});

test("VoiceOutputGateway falls back only after a cloud failure with no audio", () => {
  const fallback = [];
  let stateListener;
  class FailingTurn {
    constructor(options) { stateListener = options.onState; }
    start() {}
    append() {}
    finish() { stateListener({ state: "error", error: "unavailable" }); }
    cancel() {}
  }
  const gateway = new VoiceOutputGateway({
    apiKey: "test",
    onAudio() {},
    onState() {},
    onFallback: (text) => fallback.push(text),
    TurnImpl: FailingTurn,
  });
  gateway.handleEvent({ event: "main.turn.accepted", data: { turnId: "voice-2" } });
  gateway.handleEvent({ event: "main.turn.delta", data: { turnId: "voice-2", delta: "本地语音接管。" } });
  gateway.handleEvent({ event: "main.turn.completed", data: { turnId: "voice-2" } });
  assert.deepEqual(fallback, ["本地语音接管。"]);
});
