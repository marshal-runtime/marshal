const { contextBridge, ipcRenderer } = require("electron");

const miniModeAPI = {
  getState: () => ipcRenderer.invoke("mini-mode:getState"),
  getAsset: (status) => ipcRenderer.invoke("mini-mode:getAsset", status),
  showMainWindow: (sessionId) => ipcRenderer.invoke("mini-mode:showMainWindow", sessionId),
  respondPermission: (requestId, action, overridePattern) =>
    ipcRenderer.invoke("copilot:resolvePermission", requestId, action, overridePattern),
  dismissApproval: (requestId) => ipcRenderer.invoke("mini-mode:dismissApproval", requestId),
  dismissNotification: () => ipcRenderer.invoke("mini-mode:dismissNotification"),
  openUrl: (url) => ipcRenderer.invoke("mini-mode:openUrl", url),
  setInteractive: (interactive) => ipcRenderer.send("mini-mode:setInteractive", interactive),
  onState: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("mini-mode:state", handler);
    return () => ipcRenderer.removeListener("mini-mode:state", handler);
  },
  onPermission: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("mini-mode:permission", handler);
    return () => ipcRenderer.removeListener("mini-mode:permission", handler);
  },
  onTheme: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("mini-mode:theme", handler);
    return () => ipcRenderer.removeListener("mini-mode:theme", handler);
  },
  onNotification: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("mini-mode:notification", handler);
    return () => ipcRenderer.removeListener("mini-mode:notification", handler);
  },
};

contextBridge.exposeInMainWorld("miniModeAPI", miniModeAPI);
