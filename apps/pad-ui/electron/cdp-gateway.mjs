import http from "node:http";
import crypto from "node:crypto";

import WebSocket, { WebSocketServer } from "ws";

const SURFACE_MARKER = "about:blank#pinvou-browser-surface";
const BLOCKED_ROOT_METHODS = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Browser.setWindowBounds",
  "Target.attachToBrowserTarget",
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.setRemoteLocations",
]);
const TARGET_ID_METHODS = new Map([
  ["Browser.getWindowForTarget", "targetId"],
  ["Target.activateTarget", "targetId"],
  ["Target.attachToTarget", "targetId"],
  ["Target.closeTarget", "targetId"],
  ["Target.exposeDevToolsProtocol", "targetId"],
  ["Target.getTargetInfo", "targetId"],
]);
const CONTEXT_SCOPED_METHODS = new Set([
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setDownloadBehavior",
  "Browser.setPermission",
]);

function endpointUrl(endpoint, suffix) {
  return new URL(suffix, `${String(endpoint).replace(/\/$/, "")}/`).toString();
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function cdpError(id, message) {
  return {
    id,
    error: {
      code: -32_000,
      message: `Pinvou Browser Gateway denied the CDP command: ${message}`,
    },
  };
}

function socketSend(socket, value) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(typeof value === "string" ? value : JSON.stringify(value));
}

function cdpRequest(webSocketUrl, method, params = {}, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP request timed out: ${method}`));
    }, timeoutMs);
    const finish = (callback, value) => {
      clearTimeout(timer);
      socket.close();
      callback(value);
    };
    socket.once("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.id !== 1) return;
      if (message.error) finish(reject, new Error(message.error.message || `${method} failed`));
      else finish(resolve, message.result);
    });
    socket.once("error", (error) => finish(reject, error));
  });
}

export function targetInfoAllowed(targetInfo, allowedContextIds, allowedTargetIds) {
  if (!targetInfo || typeof targetInfo !== "object") return false;
  if (allowedTargetIds.has(targetInfo.targetId)) return true;
  return Boolean(targetInfo.browserContextId && allowedContextIds.has(targetInfo.browserContextId));
}

export function filterTargetInfos(targetInfos, allowedContextIds, allowedTargetIds) {
  return (Array.isArray(targetInfos) ? targetInfos : []).filter((targetInfo) => (
    targetInfoAllowed(targetInfo, allowedContextIds, allowedTargetIds)
  ));
}

export class AgentCdpGateway {
  constructor({
    upstreamEndpoint,
    port,
    host = "127.0.0.1",
    surfaceMarker = SURFACE_MARKER,
    fetchImpl = fetch,
    accessToken = crypto.randomBytes(24).toString("base64url"),
    discoveryAttempts = 50,
    discoveryDelayMs = 100,
  }) {
    this.upstreamEndpoint = String(upstreamEndpoint).replace(/\/$/, "");
    this.port = Number(port);
    this.host = host;
    this.surfaceMarker = surfaceMarker;
    this.fetchImpl = fetchImpl;
    this.accessToken = accessToken;
    this.discoveryAttempts = discoveryAttempts;
    this.discoveryDelayMs = discoveryDelayMs;
    this.allowedContextIds = new Set();
    this.allowedTargetIds = new Set();
    this.server = undefined;
    this.webSocketServer = undefined;
    this.upstreamWebSocketUrl = undefined;
    this.primaryContextId = undefined;
  }

  endpoint() {
    return `http://${this.host}:${this.port}`;
  }

  async #upstreamJson(suffix) {
    const response = await this.fetchImpl(endpointUrl(this.upstreamEndpoint, suffix));
    if (!response.ok) throw new Error(`upstream CDP ${suffix} returned HTTP ${response.status}`);
    return response.json();
  }

  async #discoverSurface() {
    const version = await this.#upstreamJson("json/version");
    if (!version.webSocketDebuggerUrl) throw new Error("upstream CDP did not provide a browser WebSocket URL");
    this.upstreamWebSocketUrl = version.webSocketDebuggerUrl;

    const targets = await cdpRequest(this.upstreamWebSocketUrl, "Target.getTargets");
    const targetInfos = Array.isArray(targets?.targetInfos) ? targets.targetInfos : [];
    const surface = targetInfos.find((targetInfo) => targetInfo.url === this.surfaceMarker);
    if (!surface?.targetId || !surface?.browserContextId) {
      throw new Error("unable to identify the isolated Pinvou Browser Surface CDP context");
    }
    this.primaryContextId = surface.browserContextId;
    this.allowedContextIds.add(surface.browserContextId);
    for (const targetInfo of targetInfos) {
      if (targetInfoAllowed(targetInfo, this.allowedContextIds, this.allowedTargetIds)) {
        this.allowedTargetIds.add(targetInfo.targetId);
      }
    }
  }

  async #refreshAllowedTargets() {
    const result = await cdpRequest(this.upstreamWebSocketUrl, "Target.getTargets");
    const allowed = filterTargetInfos(
      result?.targetInfos,
      this.allowedContextIds,
      this.allowedTargetIds,
    );
    for (const targetInfo of allowed) this.allowedTargetIds.add(targetInfo.targetId);
    return allowed;
  }

  async #handleHttp(request, response) {
    const rawPathname = new URL(request.url || "/", this.endpoint()).pathname;
    const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/$/, "") : rawPathname;
    try {
      if (pathname === "/json/version") {
        const version = await this.#upstreamJson("json/version");
        jsonResponse(response, 200, {
          ...version,
          webSocketDebuggerUrl: `ws://${this.host}:${this.port}/devtools/browser/${this.accessToken}`,
        });
        return;
      }
      if (pathname === "/json" || pathname === "/json/list") {
        const allowed = await this.#refreshAllowedTargets();
        const allowedIds = new Set(allowed.map((targetInfo) => targetInfo.targetId));
        const targets = await this.#upstreamJson("json/list");
        jsonResponse(response, 200, targets.filter((target) => allowedIds.has(target.id)));
        return;
      }
      if (pathname === "/json/protocol") {
        jsonResponse(response, 200, await this.#upstreamJson("json/protocol"));
        return;
      }
      jsonResponse(response, 404, { error: "Pinvou Browser Gateway endpoint not found" });
    } catch (error) {
      jsonResponse(response, 502, { error: error.message });
    }
  }

  #bridge(client) {
    const upstream = new WebSocket(this.upstreamWebSocketUrl);
    const queued = [];
    const pending = new Map();
    const allowedSessions = new Set();
    const deniedSessions = new Set();
    const internalRequests = new Set();
    let nextInternalId = -1;

    const sendInternal = (method, params = {}, sessionId) => {
      const id = nextInternalId;
      nextInternalId -= 1;
      internalRequests.add(id);
      socketSend(upstream, { id, method, params, ...(sessionId ? { sessionId } : {}) });
    };
    const rejectCommand = (message, reason) => socketSend(client, cdpError(message.id, reason));
    const isAllowedTarget = (targetId) => Boolean(targetId && this.allowedTargetIds.has(targetId));

    const forwardClientMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        client.close(1003, "CDP messages must be valid JSON");
        return;
      }
      if (!message || message.id === undefined || typeof message.method !== "string") {
        rejectCommand(message || {}, "invalid CDP request");
        return;
      }
      if (message.sessionId && !allowedSessions.has(message.sessionId)) {
        rejectCommand(message, "session does not belong to the Browser Surface");
        return;
      }
      if (!message.sessionId && BLOCKED_ROOT_METHODS.has(message.method)) {
        rejectCommand(message, `${message.method} is outside the Browser Surface capability`);
        return;
      }

      const targetIdProperty = TARGET_ID_METHODS.get(message.method);
      if (!message.sessionId && targetIdProperty) {
        const targetId = message.params?.[targetIdProperty];
        if (targetId && !isAllowedTarget(targetId)) {
          rejectCommand(message, "target does not belong to the Browser Surface");
          return;
        }
      }
      if (!message.sessionId && message.method === "Target.sendMessageToTarget") {
        if (!allowedSessions.has(message.params?.sessionId)) {
          rejectCommand(message, "nested session does not belong to the Browser Surface");
          return;
        }
      }

      if (!message.sessionId && message.method === "Target.createTarget") {
        message.params = { ...(message.params || {}), browserContextId: this.primaryContextId };
      }
      if (!message.sessionId && CONTEXT_SCOPED_METHODS.has(message.method)) {
        const requested = message.params?.browserContextId;
        if (requested && !this.allowedContextIds.has(requested)) {
          rejectCommand(message, "browser context does not belong to the Browser Surface");
          return;
        }
        message.params = { ...(message.params || {}), browserContextId: this.primaryContextId };
      }

      pending.set(message.id, { method: message.method, params: message.params });
      socketSend(upstream, message);
    };

    client.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) forwardClientMessage(data);
      else queued.push(data);
    });
    upstream.once("open", () => {
      for (const data of queued.splice(0)) forwardClientMessage(data);
    });
    upstream.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (internalRequests.delete(message.id)) return;

      if (message.id !== undefined) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (request?.method === "Target.getTargets" && Array.isArray(message.result?.targetInfos)) {
          message.result.targetInfos = filterTargetInfos(
            message.result.targetInfos,
            this.allowedContextIds,
            this.allowedTargetIds,
          );
          for (const targetInfo of message.result.targetInfos) this.allowedTargetIds.add(targetInfo.targetId);
        }
        if (
          request?.method === "Target.getTargetInfo"
          && request.params?.targetId
          && message.result?.targetInfo
        ) {
          if (!targetInfoAllowed(message.result.targetInfo, this.allowedContextIds, this.allowedTargetIds)) {
            socketSend(client, cdpError(message.id, "target does not belong to the Browser Surface"));
            return;
          }
        }
        if (request?.method === "Target.getBrowserContexts" && Array.isArray(message.result?.browserContextIds)) {
          message.result.browserContextIds = message.result.browserContextIds.filter((contextId) => (
            this.allowedContextIds.has(contextId)
          ));
        }
        if (request?.method === "Target.createTarget" && message.result?.targetId) {
          this.allowedTargetIds.add(message.result.targetId);
        }
        socketSend(client, message);
        return;
      }

      if (message.method === "Target.attachedToTarget") {
        const { sessionId, targetInfo, waitingForDebugger } = message.params || {};
        if (targetInfoAllowed(targetInfo, this.allowedContextIds, this.allowedTargetIds)) {
          this.allowedTargetIds.add(targetInfo.targetId);
          if (sessionId) allowedSessions.add(sessionId);
          socketSend(client, message);
        } else {
          if (sessionId) deniedSessions.add(sessionId);
          if (sessionId && waitingForDebugger) {
            sendInternal("Runtime.runIfWaitingForDebugger", {}, sessionId);
          }
          if (sessionId) sendInternal("Target.detachFromTarget", { sessionId });
        }
        return;
      }
      if (message.method === "Target.detachedFromTarget") {
        const sessionId = message.params?.sessionId;
        if (allowedSessions.delete(sessionId)) socketSend(client, message);
        deniedSessions.delete(sessionId);
        return;
      }
      if (["Target.targetCreated", "Target.targetInfoChanged"].includes(message.method)) {
        const targetInfo = message.params?.targetInfo;
        if (!targetInfoAllowed(targetInfo, this.allowedContextIds, this.allowedTargetIds)) return;
        this.allowedTargetIds.add(targetInfo.targetId);
        socketSend(client, message);
        return;
      }
      if (message.method === "Target.targetDestroyed") {
        const targetId = message.params?.targetId;
        if (!this.allowedTargetIds.delete(targetId)) return;
        socketSend(client, message);
        return;
      }
      if (message.sessionId && !allowedSessions.has(message.sessionId)) return;
      socketSend(client, message);
    });
    upstream.once("error", () => client.close(1011, "upstream Chromium CDP connection failed"));
    upstream.once("close", () => client.close(1011, "upstream Chromium CDP connection closed"));
    client.once("close", () => upstream.close());
    client.once("error", () => upstream.close());
  }

  async start() {
    if (this.server) return this.endpoint();
    if (!Number.isInteger(this.port) || this.port <= 0 || this.port > 65_535) {
      throw new Error("Pinvou Browser Gateway requires a valid loopback port");
    }
    let discoveryError;
    for (let attempt = 0; attempt < this.discoveryAttempts; attempt += 1) {
      try {
        await this.#discoverSurface();
        discoveryError = undefined;
        break;
      } catch (error) {
        discoveryError = error;
        if (attempt + 1 < this.discoveryAttempts) {
          await new Promise((resolve) => setTimeout(resolve, this.discoveryDelayMs));
        }
      }
    }
    if (discoveryError) throw discoveryError;
    this.webSocketServer = new WebSocketServer({ noServer: true });
    this.webSocketServer.on("connection", (client) => this.#bridge(client));
    this.server = http.createServer((request, response) => void this.#handleHttp(request, response));
    this.server.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url || "/", this.endpoint()).pathname;
      if (pathname !== `/devtools/browser/${this.accessToken}`) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, (client) => {
        this.webSocketServer.emit("connection", client, request);
      });
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });
    return this.endpoint();
  }

  async close() {
    const server = this.server;
    const webSocketServer = this.webSocketServer;
    this.server = undefined;
    this.webSocketServer = undefined;
    for (const client of webSocketServer?.clients || []) client.close(1001, "Pinvou Browser Gateway stopped");
    webSocketServer?.close();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }
}
