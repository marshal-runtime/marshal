import { readFileSync } from "node:fs";

import type { Plugin } from "vite";
// Generate from the shipped preload, preserving method aliases and callback transforms.
// No eval or Node/Electron implementation is shipped to Safari.
export function remotePreloadPlugin(): Plugin {
  return {
    name: "marshal-remote-preload",
    resolveId(id) {
      if (id === "virtual:marshal-remote-preload") return "\0" + id;
    },
    load(id) {
      if (id !== "\0virtual:marshal-remote-preload") return;
      const source = readFileSync("electron/preload.cjs", "utf8");
      const body = source
        .slice(source.indexOf("contextBridge.exposeInMainWorld("))
        .replaceAll("process.platform", '"ios"')
        .replaceAll("process.env.MARSHAL_APP_MODE", '"release"');
      if (/require\(|process\./.test(body))
        throw new Error("Preload gained native behavior: update the remote adapter.");
      return `export function installRemotePreload(ipcRenderer) {
    const enabled = new Set(['copilotAPI','sessionsAPI','modelsAPI','settingsAPI','soulAPI','permissionsAPI','identityAPI','backendAPI','workspaceAPI','appModeAPI','platform','runtimeAuthAPI','runtimeUiAPI','runtimeExtensionsAPI']);
    const contextBridge = { exposeInMainWorld(name,value) { if(enabled.has(name)) Object.defineProperty(window,name,{value,configurable:true}); } };
    const externalFileImportBridgeToken = '';
    const externalFileImportBridgeRegistration = Promise.resolve();
    function getNativePathsForFiles() { return []; }
    const webUtils = {getPathForFile(){return '';}};
    ${body}
  }`;
    },
  };
}
