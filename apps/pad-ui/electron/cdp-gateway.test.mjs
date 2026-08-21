import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { AgentCdpGateway, filterTargetInfos } from "./cdp-gateway.mjs";

const surfaceTarget = {
  targetId: "surface-target",
  type: "page",
  title: "Pinvou Browser Surface",
  url: "about:blank#pinvou-browser-surface",
  browserContextId: "surface-context",
};
const uiTarget = {
  targetId: "ui-target",
  type: "page",
  title: "Pinvou AIOS",
  url: "file:///pinvou-aios/dist/index.html",
  browserContextId: "ui-context",
};

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function json(response, value) {
  const body = JSON.stringify(value);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(body);
}

async function fakeChromium() {
  const receivedMethods = [];
  const server = http.createServer((request, response) => {
    if (request.url === "/json/version") {
      const { port } = server.address();
      json(response, {
        Browser: "Chrome/Test",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/raw`,
      });
      return;
    }
    if (request.url === "/json/list") {
      json(response, [
        { id: surfaceTarget.targetId, type: "page", title: surfaceTarget.title, url: surfaceTarget.url },
        { id: uiTarget.targetId, type: "page", title: uiTarget.title, url: uiTarget.url },
      ]);
      return;
    }
    if (request.url === "/json/protocol") {
      json(response, { domains: [] });
      return;
    }
    response.writeHead(404).end();
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  });
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      receivedMethods.push({ method: message.method, sessionId: message.sessionId, params: message.params });
      if (message.method === "Target.getTargets") {
        socket.send(JSON.stringify({ id: message.id, result: { targetInfos: [surfaceTarget, uiTarget] } }));
        return;
      }
      if (message.method === "Target.getTargetInfo") {
        const targetInfo = [surfaceTarget, uiTarget].find(({ targetId }) => targetId === message.params?.targetId);
        socket.send(JSON.stringify({ id: message.id, result: { targetInfo } }));
        return;
      }
      if (message.method === "Target.setAutoAttach") {
        socket.send(JSON.stringify({
          method: "Target.attachedToTarget",
          params: { sessionId: "surface-session", targetInfo: surfaceTarget, waitingForDebugger: true },
        }));
        socket.send(JSON.stringify({
          method: "Target.attachedToTarget",
          params: { sessionId: "ui-session", targetInfo: uiTarget, waitingForDebugger: true },
        }));
      }
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}`,
    receivedMethods,
    async close() {
      for (const client of webSocketServer.clients) client.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function waitForMessages(socket, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => reject(new Error("timed out waiting for gateway messages")), timeoutMs);
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()));
      if (!predicate(messages)) return;
      clearTimeout(timer);
      resolve(messages);
    });
  });
}

async function waitForCondition(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for gateway condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("filters privileged targets from the Browser Surface context", () => {
  assert.deepEqual(
    filterTargetInfos([surfaceTarget, uiTarget], new Set(["surface-context"]), new Set()),
    [surfaceTarget],
  );
});

test("gateway exposes only the Browser Surface and quarantines privileged auto-attached targets", async () => {
  const chromium = await fakeChromium();
  const gatewayPort = await reserveLoopbackPort();
  const gateway = new AgentCdpGateway({
    upstreamEndpoint: chromium.endpoint,
    port: gatewayPort,
    accessToken: "test-token",
  });
  let socket;
  try {
    await gateway.start();
    const version = await fetch(`${gateway.endpoint()}/json/version`).then((response) => response.json());
    assert.equal(version.webSocketDebuggerUrl, `ws://127.0.0.1:${gatewayPort}/devtools/browser/test-token`);

    const targets = await fetch(`${gateway.endpoint()}/json/list`).then((response) => response.json());
    assert.deepEqual(targets.map(({ id }) => id), [surfaceTarget.targetId]);

    const versionWithTrailingSlash = await fetch(`${gateway.endpoint()}/json/version/`);
    assert.equal(versionWithTrailingSlash.status, 200);

    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const targetResponse = waitForMessages(socket, (messages) => messages.some(({ id }) => id === 10));
    socket.send(JSON.stringify({ id: 10, method: "Target.getTargets" }));
    const targetMessages = await targetResponse;
    const visibleTargets = targetMessages.find(({ id }) => id === 10).result.targetInfos;
    assert.deepEqual(visibleTargets.map(({ targetId }) => targetId), [surfaceTarget.targetId]);

    const attachResponse = waitForMessages(
      socket,
      (messages) => messages.some(({ id }) => id === 11)
        && messages.some(({ method }) => method === "Target.attachedToTarget"),
    );
    socket.send(JSON.stringify({
      id: 11,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    }));
    const attachMessages = await attachResponse;
    const attached = attachMessages.filter(({ method }) => method === "Target.attachedToTarget");
    assert.deepEqual(attached.map(({ params }) => params.targetInfo.targetId), [surfaceTarget.targetId]);
    await waitForCondition(() => chromium.receivedMethods.some(({ method, sessionId }) => (
      method === "Runtime.runIfWaitingForDebugger" && sessionId === "ui-session"
    )));
    assert.ok(chromium.receivedMethods.some(({ method, sessionId }) => (
      method === "Runtime.runIfWaitingForDebugger" && sessionId === "ui-session"
    )));
    assert.ok(chromium.receivedMethods.some(({ method, params }) => (
      method === "Target.detachFromTarget" && params.sessionId === "ui-session"
    )));

    const deniedResponse = waitForMessages(socket, (messages) => messages.some(({ id }) => id === 12));
    socket.send(JSON.stringify({
      id: 12,
      method: "Target.attachToTarget",
      params: { targetId: uiTarget.targetId, flatten: true },
    }));
    const denied = (await deniedResponse).find(({ id }) => id === 12);
    assert.match(denied.error.message, /does not belong to the Browser Surface/);
  } finally {
    socket?.close();
    await gateway.close();
    await chromium.close();
  }
});
