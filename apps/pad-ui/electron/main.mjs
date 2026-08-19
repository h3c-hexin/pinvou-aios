import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BaseWindow, WebContentsView, ipcMain, session } from "electron";

const electronDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.dirname(electronDirectory);
const aiosHome = process.env.PINVOU_AIOS_HOME || path.join(os.homedir(), ".pinvou-aios");
const socketPath = process.env.PINVOU_AIOS_SOCKET || path.join(aiosHome, "run", "aios.sock");
const cdpPort = Number.parseInt(process.env.PINVOU_BROWSER_CDP_PORT || "", 10);
const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;
const cdpStatePath = path.join(aiosHome, "run", "browser-cdp.json");
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

function createBrowserSurface() {
  browserView = new WebContentsView({
    webPreferences: {
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
  });
  browserView.webContents.on("did-navigate", (_event, location) => {
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
  return pathToFileURL(resolvedArtifact).toString();
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

function registerIpc() {
  const trusted = (event) => {
    if (!uiView || event.sender.id !== uiView.webContents.id) {
      throw new Error("untrusted renderer attempted to call Pinvou AIOS IPC");
    }
  };
  ipcMain.handle("daemon:request", (event, { method, params }) => {
    trusted(event);
    return daemonRequest(method, params || {});
  });
  ipcMain.handle("browser:status", (event) => {
    trusted(event);
    return browserState();
  });
  ipcMain.handle("browser:open", async (event, { location }) => {
    trusted(event);
    const target = normalizeBrowserLocation(location);
    browserOpen = true;
    applyBrowserVisibility();
    await browserView.webContents.loadURL(target);
    return sendBrowserState({ reason: "navigation" });
  });
  ipcMain.handle("browser:open-task-artifact", async (event, { taskId, location }) => {
    trusted(event);
    const target = normalizeTaskArtifactLocation(taskId, location);
    browserOpen = true;
    applyBrowserVisibility();
    await browserView.webContents.loadURL(target);
    return sendBrowserState({ reason: "task-artifact" });
  });
  ipcMain.handle("browser:control", async (event, { action }) => {
    trusted(event);
    switch (action) {
      case "back":
        if (browserView.webContents.navigationHistory.canGoBack()) browserView.webContents.navigationHistory.goBack();
        break;
      case "forward":
        if (browserView.webContents.navigationHistory.canGoForward()) browserView.webContents.navigationHistory.goForward();
        break;
      case "reload":
        browserView.webContents.reload();
        break;
      case "close":
        browserOpen = false;
        browserVisible = false;
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
  mainWindow.show();
  mainWindow.on("closed", () => {
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
  app.on("before-quit", removeCdpEndpoint);
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(async () => {
    console.log("[pinvou-aios] Electron ready");
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
