import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

async function loadVoiceRuntime() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(directory, "../src/voice-runtime.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
  return import(moduleUrl);
}

function samples(level, length = 128) {
  return new Float32Array(length).fill(level);
}

function feed(capture, level, count) {
  for (let index = 0; index < count; index += 1) capture.handleSamples(samples(level));
}

test("continuous capture retains speech while the previous utterance is still recognizing", async () => {
  const { ContinuousVoiceCapture } = await loadVoiceRuntime();
  let releaseFirst;
  const firstRecognition = new Promise((resolve) => { releaseFirst = resolve; });
  let speechStarts = 0;
  let recognitionCalls = 0;
  let concurrentRecognitions = 0;
  let maximumConcurrentRecognitions = 0;
  let firstAudioBytes = 0;
  const capture = new ContinuousVoiceCapture({
    onState() {},
    onSpeechStart() { speechStarts += 1; },
    async onUtterance(audio) {
      recognitionCalls += 1;
      concurrentRecognitions += 1;
      maximumConcurrentRecognitions = Math.max(maximumConcurrentRecognitions, concurrentRecognitions);
      if (recognitionCalls === 1) {
        firstAudioBytes = audio.byteLength;
        await firstRecognition;
      }
      concurrentRecognitions -= 1;
    },
    onError(error) { throw error; },
  });
  capture.running = true;
  capture.context = { sampleRate: 16_000 };

  feed(capture, 0, 60); // 480 ms of pre-speech audio must be retained.
  feed(capture, 0.08, 12); // 96 ms confirms the first speech start.
  feed(capture, 0, 85); // 680 ms closes the first utterance and starts recognition.
  assert.equal(recognitionCalls, 1);

  feed(capture, 0.08, 12); // A second sentence starts before recognition returns.
  assert.equal(speechStarts, 2, "capture must not discard the next sentence while ASR is pending");
  feed(capture, 0, 85);
  assert.equal(recognitionCalls, 1, "ASR calls must remain serialized");

  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recognitionCalls, 2);
  assert.equal(maximumConcurrentRecognitions, 1);
  assert.ok(firstAudioBytes >= 40_000, "the WAV should include the extended pre-speech buffer");
});
