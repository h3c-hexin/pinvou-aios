import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DaemonEventStream } from "./daemon-events.mjs";

function waitFor(predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("timed out waiting for daemon event stream"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

test("daemon event stream preserves chunked JSONL events and ignores RPC responses", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pinvou-daemon-events-"));
  const socketPath = path.join(directory, "aios.sock");
  const server = net.createServer((socket) => {
    socket.write('{"id":"rpc-1","ok":true,"result":{}}\n{"type":"event","event":"main.turn.del');
    socket.write('ta","data":{"text":"你"}}\nnot-json\n');
    socket.write('{"type":"event","event":"main.turn.completed","data":{"turnId":"voice-1"}}\n');
  });
  const events = [];
  const states = [];
  const stream = new DaemonEventStream({
    socketPath,
    retryMs: 10_000,
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    stream.start();
    await waitFor(() => events.length === 2 && states.some(({ error }) => error));
    assert.deepEqual(events.map(({ event }) => event), ["main.turn.delta", "main.turn.completed"]);
    assert.equal(events[0].data.text, "你");
    assert.ok(states.some(({ connected }) => connected === true));
    assert.match(states.find(({ error }) => error).error, /守护进程事件格式错误/);
  } finally {
    stream.stop();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
