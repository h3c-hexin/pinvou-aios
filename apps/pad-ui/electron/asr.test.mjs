import assert from "node:assert/strict";
import test from "node:test";

import {
  audioFormatForMimeType,
  createTokenPlanAsrBody,
  recognizeWithTokenPlan,
  transcriptFromTokenPlanResponse,
} from "./asr.mjs";

test("maps Chromium MediaRecorder MIME types to Qwen audio formats", () => {
  assert.deepEqual(audioFormatForMimeType("audio/webm;codecs=opus"), {
    mimeType: "audio/webm",
    format: "webm",
  });
  assert.deepEqual(audioFormatForMimeType("audio/ogg; codecs=opus"), {
    mimeType: "audio/ogg",
    format: "ogg",
  });
});

test("builds a Token Plan ASR request with a base64 data URL", () => {
  const body = createTokenPlanAsrBody({
    audio: Uint8Array.from([1, 2, 3]),
    mimeType: "audio/webm;codecs=opus",
    sampleRate: 48_000,
  });
  assert.equal(body.model, "qwen-audio-3.0-asr-flash");
  assert.equal(body.parameters.format, "webm");
  assert.equal(body.parameters.sample_rate, 48_000);
  assert.equal(
    body.input.messages[0].content[0].input_audio.data,
    "data:audio/webm;base64,AQID",
  );
});

test("extracts both documented Token Plan ASR response shapes", () => {
  assert.equal(transcriptFromTokenPlanResponse({ output: { text: " 你好 " } }), "你好");
  assert.equal(
    transcriptFromTokenPlanResponse({ output: { output: { sentence: { text: "世界" } } } }),
    "世界",
  );
});

test("calls the Token Plan endpoint without exposing the key in the body", async () => {
  let request;
  const result = await recognizeWithTokenPlan({
    audio: Uint8Array.from([1, 2, 3]),
    mimeType: "audio/webm",
    sampleRate: 48_000,
    apiKey: "sk-sp-test",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ output: { text: "测试成功" }, request_id: "req-1" }));
    },
  });

  assert.match(request.url, /^https:\/\/token-plan\.cn-beijing\.maas\.aliyuncs\.com\//);
  assert.equal(request.options.headers.Authorization, "Bearer sk-sp-test");
  assert.doesNotMatch(request.options.body, /sk-sp-test/);
  assert.deepEqual(result, {
    text: "测试成功",
    requestId: "req-1",
    model: "qwen-audio-3.0-asr-flash",
  });
});

test("surfaces Token Plan API errors without leaking credentials", async () => {
  await assert.rejects(
    recognizeWithTokenPlan({
      audio: Uint8Array.from([1]),
      mimeType: "audio/webm",
      apiKey: "sk-sp-secret",
      fetchImpl: async () => new Response(
        JSON.stringify({ code: "InvalidApiKey", message: "invalid key" }),
        { status: 401 },
      ),
    }),
    /千问 ASR 请求失败：invalid key/,
  );
});
