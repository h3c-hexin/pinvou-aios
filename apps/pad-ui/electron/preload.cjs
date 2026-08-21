const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pinvou", Object.freeze({
  daemonRequest(method, params = {}) {
    return ipcRenderer.invoke("daemon:request", { method, params });
  },
  setThemeMode(mode) {
    return ipcRenderer.invoke("theme:set", { mode });
  },
  voiceRecognize(audio, mimeType, sampleRate) {
    return ipcRenderer.invoke("voice:recognize", { audio, mimeType, sampleRate });
  },
  voiceInterruptOutput() {
    return ipcRenderer.invoke("voice:interrupt-output");
  },
  browserStatus() {
    return ipcRenderer.invoke("browser:status");
  },
  browserOpen(location) {
    return ipcRenderer.invoke("browser:open", { location });
  },
  browserOpenTaskArtifact(taskId, location) {
    return ipcRenderer.invoke("browser:open-task-artifact", { taskId, location });
  },
  browserControl(action) {
    return ipcRenderer.invoke("browser:control", { action });
  },
  browserSetBounds(bounds) {
    return ipcRenderer.invoke("browser:set-bounds", bounds);
  },
  surfaceSetEditMode(enabled) {
    return ipcRenderer.invoke("surface:set-edit-mode", { enabled });
  },
  surfaceClearSelection() {
    return ipcRenderer.invoke("surface:clear-selection");
  },
  surfaceModify(instruction) {
    return ipcRenderer.invoke("surface:modify", { instruction });
  },
  surfaceUndo() {
    return ipcRenderer.invoke("surface:undo");
  },
  onBrowserState(listener) {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("browser:state", handler);
    return () => ipcRenderer.removeListener("browser:state", handler);
  },
  onSurfaceSelection(listener) {
    const handler = (_event, selection) => listener(selection);
    ipcRenderer.on("surface:selection", handler);
    return () => ipcRenderer.removeListener("surface:selection", handler);
  },
  onDaemonEvent(listener) {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("daemon:event", handler);
    return () => ipcRenderer.removeListener("daemon:event", handler);
  },
  onVoiceAudio(listener) {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("voice:audio", handler);
    return () => ipcRenderer.removeListener("voice:audio", handler);
  },
  onVoiceClearAudio(listener) {
    const handler = () => listener();
    ipcRenderer.on("voice:clear-audio", handler);
    return () => ipcRenderer.removeListener("voice:clear-audio", handler);
  },
  onVoiceOutputState(listener) {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("voice:output-state", handler);
    return () => ipcRenderer.removeListener("voice:output-state", handler);
  },
  onVoiceFallback(listener) {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("voice:fallback", handler);
    return () => ipcRenderer.removeListener("voice:fallback", handler);
  },
  onVoiceCancelFallback(listener) {
    const handler = () => listener();
    ipcRenderer.on("voice:cancel-fallback", handler);
    return () => ipcRenderer.removeListener("voice:cancel-fallback", handler);
  },
}));
