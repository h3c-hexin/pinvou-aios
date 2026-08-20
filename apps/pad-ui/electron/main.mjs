import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BaseWindow, WebContentsView, ipcMain, safeStorage, session } from "electron";

import { recognizeWithTokenPlan } from "./asr.mjs";
import { DaemonEventStream } from "./daemon-events.mjs";
import { VoiceOutputGateway } from "./tts.mjs";

const electronDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.dirname(electronDirectory);
const aiosHome = process.env.PINVOU_AIOS_HOME || path.join(os.homedir(), ".pinvou-aios");
const socketPath = process.env.PINVOU_AIOS_SOCKET || path.join(aiosHome, "run", "aios.sock");
const cdpPort = Number.parseInt(process.env.PINVOU_BROWSER_CDP_PORT || "", 10);
const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
const cdpStatePath = path.join(aiosHome, "run", "browser-cdp.json");
const tokenPlanCredentialPath = path.join(aiosHome, "credentials", "token-plan.enc");
const instanceId = crypto.randomUUID();

console.log(`[pinvou-aios] Electron main starting (pid=${process.pid}, cdp=${cdpEndpoint})`);

if (!Number.isInteger(cdpPort) || cdpPort <= 0 || cdpPort > 65535) {
  throw new Error("PINVOU_BROWSER_CDP_PORT must contain a valid TCP port");
}

fs.mkdirSync(path.join(aiosHome, "electron"), { recursive: true });
app.setPath("userData", path.join(aiosHome, "electron"));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
app.commandLine.appendSwitch("disable-features", "AutofillServerCommunication");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow;
let uiView;
let browserView;
let browserVisible = false;
let browserOpen = false;
let browserLoading = false;
let browserTitle = "";
let browserBounds = { x: 0, y: 0, width: 0, height: 0 };
let currentTaskArtifact;
let browserReturnStack = [];
let surfaceEditMode = false;
let surfaceSelection;
let artifactWatcher;
let artifactReloadTimer;
let voiceRecognitionInFlight = false;
let daemonEventStream;
let tokenPlanApiKey;
let voiceOutput;

function loadTokenPlanCredential() {
  const fromEnvironment = String(process.env.PINVOU_TOKEN_PLAN_API_KEY || "").trim();
  if (fromEnvironment) {
    if (safeStorage.isEncryptionAvailable()) {
      fs.mkdirSync(path.dirname(tokenPlanCredentialPath), { recursive: true, mode: 0o700 });
      const temporary = `${tokenPlanCredentialPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, safeStorage.encryptString(fromEnvironment), { mode: 0o600 });
      fs.renameSync(temporary, tokenPlanCredentialPath);
    } else {
      console.warn("[pinvou-aios] OS credential encryption is unavailable; Token Plan key was not persisted");
    }
    return fromEnvironment;
  }
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.decryptString(fs.readFileSync(tokenPlanCredentialPath));
  } catch {
    return undefined;
  }
}

function createVoiceOutput() {
  return new VoiceOutputGateway({
    apiKey: tokenPlanApiKey,
    endpoint: process.env.PINVOU_TTS_WEBSOCKET_URL,
    voice: process.env.PINVOU_TTS_VOICE || "longanlingxin",
    onAudio(audio) {
      if (uiView && !uiView.webContents.isDestroyed()) {
        uiView.webContents.send("voice:audio", {
          audio: new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength),
          sampleRate: 24_000,
        });
      }
    },
    onState(state) {
      if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.send("voice:output-state", state);
    },
    onFallback(text) {
      if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.send("voice:fallback", { text });
    },
  });
}

function handleDaemonEvent(event) {
  voiceOutput?.handleEvent(event);
  if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.send("daemon:event", event);
}

function sendBrowserState(extra = {}) {
  const state = browserState(extra);
  if (uiView && !uiView.webContents.isDestroyed()) {
    uiView.webContents.send("browser:state", state);
  }
  return state;
}

function browserState(extra = {}) {
  return {
    ready: Boolean(browserView),
    open: browserOpen,
    visible: browserVisible && browserOpen,
    loading: browserLoading,
    location: browserView && !browserView.webContents.isDestroyed()
      ? browserView.webContents.getURL()
      : "about:blank",
    title: browserTitle,
    bounds: browserBounds,
    cdpEndpoint,
    editable: Boolean(currentTaskArtifact),
    editMode: surfaceEditMode,
    taskId: currentTaskArtifact?.taskId,
    canReturn: browserReturnStack.length > 0,
    contextDepth: browserReturnStack.length,
    selection: surfaceSelection
      ? { taskId: currentTaskArtifact?.taskId, ...surfaceSelection }
      : undefined,
    ...extra,
  };
}

function hasBrowserContent(location) {
  return Boolean(location)
    && location !== "about:blank"
    && !location.startsWith("about:blank#pinvou-browser-surface");
}

function applyBrowserVisibility() {
  if (!browserView) return;
  const visible = browserVisible && browserOpen && browserBounds.width > 0 && browserBounds.height > 0;
  browserView.setBounds(browserBounds);
  browserView.setVisible(visible);
  if (visible) {
    mainWindow.contentView.removeChildView(browserView);
    mainWindow.contentView.addChildView(browserView);
  }
}

function sendSurfaceSelection() {
  if (uiView && !uiView.webContents.isDestroyed()) {
    uiView.webContents.send("surface:selection", surfaceSelection
      ? { taskId: currentTaskArtifact?.taskId, ...surfaceSelection }
      : null);
  }
}

function stopArtifactWatcher() {
  if (artifactWatcher) artifactWatcher.close();
  artifactWatcher = undefined;
  if (artifactReloadTimer) clearTimeout(artifactReloadTimer);
  artifactReloadTimer = undefined;
}

function watchCurrentArtifact() {
  stopArtifactWatcher();
  if (!currentTaskArtifact) return;
  const directory = path.dirname(currentTaskArtifact.path);
  const filename = path.basename(currentTaskArtifact.path);
  artifactWatcher = fs.watch(directory, (_eventType, changed) => {
    if (changed && String(changed) !== filename) return;
    if (artifactReloadTimer) clearTimeout(artifactReloadTimer);
    artifactReloadTimer = setTimeout(() => {
      artifactReloadTimer = undefined;
      if (!currentTaskArtifact || !browserView || browserView.webContents.isDestroyed()) return;
      if (!isCurrentTaskArtifact(browserView.webContents.getURL())) return;
      browserView.webContents.reload();
    }, 350);
  });
  artifactWatcher.on("error", (error) => {
    sendBrowserState({ error: `无法监控 HTML 产物变化：${error.message}` });
  });
}

function clearTaskArtifact({ notifyDaemon = true } = {}) {
  const previous = currentTaskArtifact;
  stopArtifactWatcher();
  currentTaskArtifact = undefined;
  surfaceEditMode = false;
  surfaceSelection = undefined;
  sendSurfaceSelection();
  if (notifyDaemon && previous?.contextId) {
    void daemonRequest("surface.deactivate", { contextId: previous.contextId }).catch((error) => {
      console.warn("[pinvou-aios] failed to deactivate artifact context", error.message);
    });
  }
}

async function activateCurrentTaskArtifact() {
  if (!currentTaskArtifact) return undefined;
  return daemonRequest("surface.activate", {
    contextId: currentTaskArtifact.contextId,
    taskId: currentTaskArtifact.taskId,
    artifactPath: currentTaskArtifact.path,
  });
}

async function captureBrowserEnvironment() {
  const location = browserView && !browserView.webContents.isDestroyed()
    ? browserView.webContents.getURL()
    : "about:blank#pinvou-browser-surface";
  let scroll = { x: 0, y: 0 };
  if (browserOpen && hasBrowserContent(location)) {
    scroll = await browserView.webContents.executeJavaScript(
      "({ x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) })",
      true,
    ).catch(() => scroll);
  }
  return {
    open: browserOpen,
    location,
    title: browserTitle,
    scroll,
    artifact: currentTaskArtifact
      ? {
          taskId: currentTaskArtifact.taskId,
          path: currentTaskArtifact.path,
          target: currentTaskArtifact.target,
        }
      : undefined,
    editMode: surfaceEditMode,
    selection: surfaceSelection ? structuredClone(surfaceSelection) : undefined,
  };
}

async function restoreBrowserEnvironment() {
  const environment = browserReturnStack.pop();
  clearTaskArtifact();
  if (!environment) {
    browserOpen = false;
    browserVisible = false;
    browserTitle = "";
    applyBrowserVisibility();
    return sendBrowserState({ reason: "closed" });
  }

  if (!environment.open || !hasBrowserContent(environment.location)) {
    browserOpen = false;
    browserTitle = environment.title || "";
    await browserView.webContents.loadURL("about:blank#pinvou-browser-surface");
    applyBrowserVisibility();
    return sendBrowserState({ reason: "context-restored" });
  }

  browserOpen = true;
  applyBrowserVisibility();
  await browserView.webContents.loadURL(environment.location);
  browserTitle = environment.title || browserTitle;
  await browserView.webContents.executeJavaScript(
    `window.scrollTo(${Math.round(environment.scroll?.x || 0)}, ${Math.round(environment.scroll?.y || 0)})`,
    true,
  ).catch(() => undefined);

  if (environment.artifact) {
    currentTaskArtifact = {
      ...environment.artifact,
      contextId: crypto.randomUUID(),
    };
    surfaceEditMode = Boolean(environment.editMode);
    surfaceSelection = environment.selection;
    watchCurrentArtifact();
    await activateCurrentTaskArtifact();
    if (surfaceEditMode) {
      browserView.webContents.send("surface:edit-mode", {
        enabled: true,
        restoreSelector: surfaceSelection?.selector,
      });
    }
    sendSurfaceSelection();
  }
  applyBrowserVisibility();
  return sendBrowserState({ reason: "context-restored" });
}

function isCurrentTaskArtifact(location) {
  if (!currentTaskArtifact) return false;
  try {
    const parsed = new URL(location);
    if (parsed.protocol !== "file:") return false;
    return path.resolve(fileURLToPath(parsed)) === currentTaskArtifact.path;
  } catch {
    return false;
  }
}

function setSurfaceEditMode(enabled) {
  if (enabled && (!currentTaskArtifact || !isCurrentTaskArtifact(browserView.webContents.getURL()))) {
    throw new Error("AI 修改仅支持从任务卡片打开的本地 HTML 产物");
  }
  surfaceEditMode = Boolean(enabled);
  if (!surfaceEditMode) {
    surfaceSelection = undefined;
    sendSurfaceSelection();
  }
  browserView.webContents.send("surface:edit-mode", {
    enabled: surfaceEditMode,
    restoreSelector: surfaceSelection?.selector,
  });
  return sendBrowserState({ reason: "surface-edit-mode" });
}

function cleanString(value, maximum) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.slice(0, maximum);
  return cleaned || undefined;
}

function sanitizeSurfaceSelection(value) {
  if (!value || typeof value !== "object") return undefined;
  const selector = cleanString(value.selector, 2_000);
  const tagName = cleanString(value.tagName, 80);
  if (!selector || !tagName) return undefined;
  const stringMap = (input, maximumEntries, maximumValue) => Object.fromEntries(
    Object.entries(input && typeof input === "object" ? input : {})
      .slice(0, maximumEntries)
      .map(([key, item]) => [String(key).slice(0, 100), cleanString(item, maximumValue) || ""]),
  );
  const rect = value.rect && typeof value.rect === "object"
    ? Object.fromEntries(["x", "y", "width", "height"].map((key) => [
      key,
      Number.isFinite(Number(value.rect[key])) ? Math.round(Number(value.rect[key])) : 0,
    ]))
    : {};
  return {
    selector,
    nodeId: cleanString(value.nodeId, 300),
    tagName,
    text: cleanString(value.text, 1_000) || "",
    outerHTML: cleanString(value.outerHTML, 8_000) || "",
    attributes: stringMap(value.attributes, 30, 500),
    breadcrumbs: Array.isArray(value.breadcrumbs)
      ? value.breadcrumbs.slice(0, 8).map((item) => String(item).slice(0, 300))
      : [],
    rect,
    styles: stringMap(value.styles, 30, 500),
  };
}

function createBrowserSurface() {
  browserView = new WebContentsView({
    webPreferences: {
      preload: path.join(electronDirectory, "browser-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.contentView.addChildView(browserView);
  browserView.setVisible(false);
  browserView.webContents.loadURL("about:blank#pinvou-browser-surface");

  browserView.webContents.on("did-start-loading", () => {
    browserLoading = true;
    sendBrowserState();
  });
  browserView.webContents.on("did-stop-loading", () => {
    browserLoading = false;
    const location = browserView.webContents.getURL();
    if (hasBrowserContent(location)) browserOpen = true;
    applyBrowserVisibility();
    sendBrowserState({ reason: "navigation" });
    if (surfaceEditMode && currentTaskArtifact && isCurrentTaskArtifact(location)) {
      browserView.webContents.send("surface:edit-mode", {
        enabled: true,
        restoreSelector: surfaceSelection?.selector,
      });
    }
  });
  browserView.webContents.on("did-navigate", (_event, location) => {
    if (currentTaskArtifact && !isCurrentTaskArtifact(location)) clearTaskArtifact();
    if (hasBrowserContent(location)) browserOpen = true;
    applyBrowserVisibility();
    sendBrowserState({ location, reason: "navigation" });
  });
  browserView.webContents.on("did-navigate-in-page", (_event, location) => {
    sendBrowserState({ location, reason: "navigation" });
  });
  browserView.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    browserTitle = title;
    sendBrowserState({ title });
  });
  browserView.webContents.on("render-process-gone", (_event, details) => {
    browserOpen = false;
    applyBrowserVisibility();
    sendBrowserState({ error: `浏览器渲染进程已退出：${details.reason}` });
  });
  browserView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedBrowserUrl(url)) void browserView.webContents.loadURL(url);
    return { action: "deny" };
  });
}

function isAllowedBrowserUrl(location) {
  try {
    return ["http:", "https:", "file:", "about:"].includes(new URL(location).protocol);
  } catch {
    return false;
  }
}

function normalizeBrowserLocation(value) {
  const location = String(value || "").trim();
  if (!location) throw new Error("请输入网页地址或本地 HTML 路径");
  if (location.startsWith("~/")) {
    return pathToFileURL(path.join(os.homedir(), location.slice(2))).toString();
  }
  if (path.isAbsolute(location)) return pathToFileURL(location).toString();
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(location) ? location : `https://${location}`;
  if (!isAllowedBrowserUrl(withScheme)) throw new Error("仅支持 HTTP、HTTPS 和本地 HTML 页面");
  return withScheme;
}

function normalizeTaskArtifactLocation(taskIdValue, locationValue) {
  const taskId = String(taskIdValue || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
    throw new Error("任务产物包含无效的任务 ID");
  }

  const location = String(locationValue || "").trim();
  if (!location) throw new Error("任务没有提供 HTML 产物路径");
  const taskWorkspace = fs.realpathSync(path.join(aiosHome, "workspaces", "tasks", taskId));
  let artifactPath;
  if (location.startsWith("file:")) {
    artifactPath = fileURLToPath(new URL(location));
  } else if (path.isAbsolute(location)) {
    artifactPath = location;
  } else {
    artifactPath = path.resolve(taskWorkspace, location);
  }

  const resolvedArtifact = fs.realpathSync(artifactPath);
  const relative = path.relative(taskWorkspace, resolvedArtifact);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("任务 HTML 产物必须位于该任务自己的工作目录中");
  }
  if (![".html", ".htm"].includes(path.extname(resolvedArtifact).toLowerCase())) {
    throw new Error("任务产物不是 HTML 文件");
  }
  if (!fs.statSync(resolvedArtifact).isFile()) {
    throw new Error("任务 HTML 产物路径不是文件");
  }
  return {
    taskId,
    path: resolvedArtifact,
    target: pathToFileURL(resolvedArtifact).toString(),
  };
}

function daemonRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`AIOS 守护进程响应超时：${method}`)),
      35_000,
    );

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let response;
        try {
          response = JSON.parse(line);
        } catch (error) {
          finish(reject, error);
          return;
        }
        if (response.id !== id) continue;
        if (response.ok) finish(resolve, response.result);
        else finish(reject, new Error(response.error || `AIOS 守护进程拒绝请求：${method}`));
        return;
      }
    });
    socket.once("error", (error) => finish(reject, error));
  });
}

async function publishCdpEndpoint() {
  fs.mkdirSync(path.dirname(cdpStatePath), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${cdpEndpoint}/json/version`);
      if (response.ok) {
        const version = await response.json();
        const payload = JSON.stringify({
          instanceId,
          pid: process.pid,
          endpoint: cdpEndpoint,
          browser: version.Browser,
          createdAt: new Date().toISOString(),
        }, null, 2);
        const temporary = `${cdpStatePath}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, payload, { mode: 0o600 });
        fs.renameSync(temporary, cdpStatePath);
        return;
      }
    } catch {
      // Chromium exposes the endpoint shortly after the Electron ready event.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chromium CDP endpoint did not start at ${cdpEndpoint}`);
}

function removeCdpEndpoint() {
  try {
    const state = JSON.parse(fs.readFileSync(cdpStatePath, "utf8"));
    if (state.instanceId === instanceId) fs.unlinkSync(cdpStatePath);
  } catch {
    // A missing or newer endpoint file must be left alone.
  }
}

function configureUiPermissions() {
  const uiSession = uiView.webContents.session;
  const isTrustedUi = (webContents) => Boolean(
    webContents
    && uiView
    && !uiView.webContents.isDestroyed()
    && webContents.id === uiView.webContents.id,
  );
  uiSession.setPermissionCheckHandler((webContents, permission, _origin, details) => (
    isTrustedUi(webContents)
    && permission === "media"
    && details?.mediaType !== "video"
    && details?.isMainFrame !== false
  ));
  uiSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    const audioOnly = mediaTypes.length === 0 || mediaTypes.every((type) => type === "audio");
    callback(
      isTrustedUi(webContents)
      && permission === "media"
      && audioOnly
      && details?.isMainFrame !== false,
    );
  });
}

function registerIpc() {
  const trusted = (event) => {
    if (!uiView || event.sender.id !== uiView.webContents.id) {
      throw new Error("untrusted renderer attempted to call Pinvou AIOS IPC");
    }
  };
  ipcMain.on("surface:selection", (event, value) => {
    if (!browserView || event.sender.id !== browserView.webContents.id) return;
    if (!surfaceEditMode || !currentTaskArtifact) return;
    surfaceSelection = sanitizeSurfaceSelection(value);
    sendSurfaceSelection();
  });
  ipcMain.handle("daemon:request", (event, { method, params }) => {
    trusted(event);
    return daemonRequest(method, params || {});
  });
  ipcMain.handle("voice:recognize", async (event, { audio, mimeType, sampleRate }) => {
    trusted(event);
    if (voiceRecognitionInFlight) throw new Error("上一段语音仍在识别，请稍候");
    voiceRecognitionInFlight = true;
    try {
      return await recognizeWithTokenPlan({
        audio,
        mimeType,
        sampleRate,
        apiKey: tokenPlanApiKey,
      });
    } finally {
      voiceRecognitionInFlight = false;
    }
  });
  ipcMain.handle("voice:interrupt-output", (event) => {
    trusted(event);
    voiceOutput?.cancel();
    uiView.webContents.send("voice:clear-audio");
    uiView.webContents.send("voice:cancel-fallback");
    return { interrupted: true };
  });
  ipcMain.handle("browser:status", (event) => {
    trusted(event);
    return browserState();
  });
  ipcMain.handle("browser:open", async (event, { location }) => {
    trusted(event);
    const target = normalizeBrowserLocation(location);
    clearTaskArtifact();
    browserOpen = true;
    applyBrowserVisibility();
    await browserView.webContents.loadURL(target);
    return sendBrowserState({ reason: "navigation" });
  });
  ipcMain.handle("browser:open-task-artifact", async (event, { taskId, location }) => {
    trusted(event);
    const environment = await captureBrowserEnvironment();
    browserReturnStack.push(environment);
    clearTaskArtifact();
    currentTaskArtifact = {
      ...normalizeTaskArtifactLocation(taskId, location),
      contextId: crypto.randomUUID(),
    };
    watchCurrentArtifact();
    browserOpen = true;
    applyBrowserVisibility();
    try {
      await browserView.webContents.loadURL(currentTaskArtifact.target);
      await activateCurrentTaskArtifact();
      return sendBrowserState({ reason: "task-artifact" });
    } catch (error) {
      clearTaskArtifact();
      await restoreBrowserEnvironment();
      throw error;
    }
  });
  ipcMain.handle("browser:control", async (event, { action }) => {
    trusted(event);
    switch (action) {
      case "back":
        if (currentTaskArtifact && browserReturnStack.length > 0) {
          return restoreBrowserEnvironment();
        }
        if (browserView.webContents.navigationHistory.canGoBack()) browserView.webContents.navigationHistory.goBack();
        break;
      case "forward":
        if (browserView.webContents.navigationHistory.canGoForward()) browserView.webContents.navigationHistory.goForward();
        break;
      case "reload":
        browserView.webContents.reload();
        break;
      case "close":
      case "return":
        if (browserReturnStack.length > 0) {
          return restoreBrowserEnvironment();
        }
        browserOpen = false;
        browserVisible = false;
        browserTitle = "";
        clearTaskArtifact();
        applyBrowserVisibility();
        break;
      default:
        throw new Error(`不支持的浏览器操作：${action}`);
    }
    return sendBrowserState();
  });
  ipcMain.handle("browser:set-bounds", (event, { x, y, width, height, visible }) => {
    trusted(event);
    browserBounds = {
      x: Math.max(0, Math.round(Number(x) || 0)),
      y: Math.max(0, Math.round(Number(y) || 0)),
      width: Math.max(0, Math.round(Number(width) || 0)),
      height: Math.max(0, Math.round(Number(height) || 0)),
    };
    browserVisible = Boolean(visible);
    applyBrowserVisibility();
    return browserState();
  });
  ipcMain.handle("surface:set-edit-mode", (event, { enabled }) => {
    trusted(event);
    return setSurfaceEditMode(enabled);
  });
  ipcMain.handle("surface:clear-selection", (event) => {
    trusted(event);
    if (!surfaceEditMode) return browserState();
    surfaceSelection = undefined;
    browserView.webContents.send("surface:clear-selection");
    sendSurfaceSelection();
    return browserState();
  });
  ipcMain.handle("surface:modify", async (event, { instruction }) => {
    trusted(event);
    if (!surfaceEditMode || !currentTaskArtifact) throw new Error("请先打开任务 HTML 并开启 AI 修改");
    if (!surfaceSelection) throw new Error("请先在页面中点击要修改的元素");
    const request = String(instruction || "").trim();
    if (!request) throw new Error("请输入修改要求");
    if (request.length > 4_000) throw new Error("单次修改要求不能超过 4000 个字符");
    return daemonRequest("surface.modify", {
      taskId: currentTaskArtifact.taskId,
      artifactPath: currentTaskArtifact.path,
      instruction: request,
      selection: surfaceSelection,
    });
  });
  ipcMain.handle("surface:undo", async (event) => {
    trusted(event);
    if (!currentTaskArtifact) throw new Error("当前页面不是可编辑的任务 HTML");
    return daemonRequest("surface.undo", {
      taskId: currentTaskArtifact.taskId,
      artifactPath: currentTaskArtifact.path,
    });
  });
}

async function createMainWindow() {
  mainWindow = new BaseWindow({
    title: "Pinvou AIOS",
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#080a0f",
    show: false,
  });
  // Create the shared browser before the shell UI so Playwright's first CDP
  // page is the web surface, never the privileged AIOS renderer.
  createBrowserSurface();
  uiView = new WebContentsView({
    webPreferences: {
      preload: path.join(electronDirectory, "preload.cjs"),
      partition: "persist:pinvou-ui",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  configureUiPermissions();
  mainWindow.contentView.addChildView(uiView);
  const layoutUi = () => {
    const [width, height] = mainWindow.getContentSize();
    uiView.setBounds({ x: 0, y: 0, width, height });
    applyBrowserVisibility();
  };
  layoutUi();
  mainWindow.on("resize", layoutUi);
  registerIpc();

  const developmentUrl = process.env.PINVOU_AIOS_UI_DEV_URL;
  if (developmentUrl) await uiView.webContents.loadURL(developmentUrl);
  else await uiView.webContents.loadFile(path.join(appDirectory, "dist", "index.html"));
  await daemonRequest("surface.deactivate", {}).catch((error) => {
    console.warn("[pinvou-aios] failed to clear stale artifact context", error.message);
  });
  daemonEventStream = new DaemonEventStream({
    socketPath,
    onEvent: handleDaemonEvent,
    onState(state) {
      if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.send("daemon:event-state", state);
      if (state.connected && currentTaskArtifact) {
        const contextId = currentTaskArtifact.contextId;
        void activateCurrentTaskArtifact().catch((error) => {
          if (currentTaskArtifact?.contextId !== contextId) return;
          console.warn("[pinvou-aios] failed to restore artifact context after daemon reconnect", error.message);
          sendBrowserState({ error: `主 Agent 页面上下文恢复失败：${error.message}` });
        });
      }
    },
  });
  daemonEventStream.start();
  mainWindow.show();
  mainWindow.on("closed", () => {
    daemonEventStream?.stop();
    daemonEventStream = undefined;
    voiceOutput?.cancel();
    stopArtifactWatcher();
    if (browserView && !browserView.webContents.isDestroyed()) browserView.webContents.close();
    if (uiView && !uiView.webContents.isDestroyed()) uiView.webContents.close();
    browserView = undefined;
    uiView = undefined;
    mainWindow = undefined;
  });
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("before-quit", () => {
    daemonEventStream?.stop();
    voiceOutput?.cancel();
    removeCdpEndpoint();
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(async () => {
    console.log("[pinvou-aios] Electron ready");
    tokenPlanApiKey = loadTokenPlanCredential();
    voiceOutput = createVoiceOutput();
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    await createMainWindow();
    console.log("[pinvou-aios] main window created");
    await publishCdpEndpoint();
    console.log(`[pinvou-aios] embedded Chromium ready at ${cdpEndpoint}`);
  }).catch((error) => {
    console.error("[pinvou-aios] failed to start Electron shell", error);
    app.exit(1);
  });
}
