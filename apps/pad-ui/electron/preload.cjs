const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pinvou", Object.freeze({
  daemonRequest(method, params = {}) {
    return ipcRenderer.invoke("daemon:request", { method, params });
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
  onBrowserState(listener) {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("browser:state", handler);
    return () => ipcRenderer.removeListener("browser:state", handler);
  },
}));
