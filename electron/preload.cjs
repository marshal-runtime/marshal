const { contextBridge, ipcRenderer, webUtils } = require("electron");

function createExternalFileImportBridgeToken() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return require("node:crypto").randomBytes(16).toString("hex");
}

const externalFileImportBridgeToken = createExternalFileImportBridgeToken();
const externalFileImportBridgeRegistration = ipcRenderer.invoke(
  "workspace:registerExternalFileImportBridge",
  externalFileImportBridgeToken,
);

function getNativePathsForFiles(files) {
  if (!files || typeof files !== "object") return [];

  const paths = [];
  for (const file of Array.from(files)) {
    if (!file || typeof file !== "object") continue;
    const isFile =
      (typeof File !== "undefined" && file instanceof File) ||
      Object.prototype.toString.call(file) === "[object File]";
    if (!isFile) continue;
    const filePath = webUtils.getPathForFile(file);
    if (typeof filePath === "string" && filePath) {
      paths.push(filePath);
    }
  }
  return paths;
}

contextBridge.exposeInMainWorld("copilotAPI", {
  init: () => ipcRenderer.invoke("copilot:init"),
  send: (message, sessionId, attachments, clientMessageId) =>
    ipcRenderer.invoke("copilot:send", message, sessionId, attachments, clientMessageId),
  steer: (message, sessionId, attachments, clientMessageId) =>
    ipcRenderer.invoke("copilot:steer", message, sessionId, attachments, clientMessageId),
  abort: (sessionId) => ipcRenderer.invoke("copilot:abort", sessionId),
  destroy: () => ipcRenderer.invoke("copilot:destroy"),
  saveImage: (base64Data, mimeType) =>
    ipcRenderer.invoke("copilot:saveImage", base64Data, mimeType),
  checkAuth: () => ipcRenderer.invoke("copilot:checkAuth"),
  getVersion: () => ipcRenderer.invoke("copilot:getVersion"),
  getSystemInfo: () => ipcRenderer.invoke("copilot:getSystemInfo"),
  login: () => ipcRenderer.invoke("copilot:login"),
  startDeviceFlow: () => ipcRenderer.invoke("copilot:startDeviceFlow"),
  openDeviceFlowPage: (code) => ipcRenderer.invoke("copilot:openDeviceFlowPage", code),
  signOut: () => ipcRenderer.invoke("copilot:signOut"),
  // overridePattern is UNTRUSTED — the main-process handler re-runs guardrails
  // on it before writing to request.approvalPattern. See permission-card-manager.resolve.
  resolvePermission: (requestId, action, overridePattern) =>
    ipcRenderer.invoke("copilot:resolvePermission", requestId, action, overridePattern),
  onAuthError: (callback) => {
    const handler = (_event, error) => callback(error);
    ipcRenderer.on("copilot:authError", handler);
    return () => ipcRenderer.removeListener("copilot:authError", handler);
  },
  onLoginFailed: (callback) => {
    const handler = (_event, reason) => callback(reason);
    ipcRenderer.on("copilot:loginFailed", handler);
    return () => ipcRenderer.removeListener("copilot:loginFailed", handler);
  },
});

contextBridge.exposeInMainWorld("overlayReviewAPI", {
  launch: (request) => ipcRenderer.invoke("overlay-review:launch", request),
  claim: (sessionId) => ipcRenderer.invoke("overlay-review:claim", sessionId),
  onPending: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("overlay-review:pending", handler);
    return () => ipcRenderer.removeListener("overlay-review:pending", handler);
  },
  onError: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("overlay-review:error", handler);
    return () => ipcRenderer.removeListener("overlay-review:error", handler);
  },
});

contextBridge.exposeInMainWorld("sessionsAPI", {
  list: (query) => ipcRenderer.invoke("sessions:list", query),
  listWithOptions: (options) => ipcRenderer.invoke("sessions:listWithOptions", options),
  create: (model, soul, options) => ipcRenderer.invoke("sessions:create", model, soul, options),
  createMain: (model, soul, selection) =>
    ipcRenderer.invoke("sessions:createMain", model, soul, selection),
  createOrReuseEmpty: (options) => ipcRenderer.invoke("sessions:createOrReuseEmpty", options),
  compact: (sessionId) => ipcRenderer.invoke("sessions:compact", sessionId),
  switch: (sessionId) => ipcRenderer.invoke("sessions:switch", sessionId),
  delete: (sessionId) => ipcRenderer.invoke("sessions:delete", sessionId),
  deleteAll: (options) => ipcRenderer.invoke("sessions:delete-all", options),
  rename: (sessionId, name, aiGeneratedTitle) =>
    ipcRenderer.invoke("sessions:rename", sessionId, name, aiGeneratedTitle),
  markRead: (sessionId) => ipcRenderer.invoke("sessions:mark-read", sessionId),
  setPinned: (sessionId, pinned) => ipcRenderer.invoke("sessions:setPinned", sessionId, pinned),
  get: (sessionId, options) => ipcRenderer.invoke("sessions:get", sessionId, options),
  getMessages: (sessionId, options) =>
    ipcRenderer.invoke("sessions:getMessages", sessionId, options),
  getToolCallDetails: (sessionId, messageId, toolCallIndex) =>
    ipcRenderer.invoke("sessions:getToolCallDetails", sessionId, messageId, toolCallIndex),
  getView: (sessionId) => ipcRenderer.invoke("sessions:getView", sessionId),
  subscribeView: (sessionId) => ipcRenderer.invoke("sessions:subscribeView", sessionId),
  unsubscribeView: (sessionId) => ipcRenderer.invoke("sessions:unsubscribeView", sessionId),
  ackView: (sessionId, epoch, sequence) =>
    ipcRenderer.invoke("sessions:ackView", sessionId, epoch, sequence),
  resyncView: (sessionId) => ipcRenderer.invoke("sessions:resyncView", sessionId),
  setModel: (sessionId, model) => ipcRenderer.invoke("sessions:setModel", sessionId, model),
  patchQuestionSelection: (sessionId, messageId, selectedAnswer) =>
    ipcRenderer.invoke("sessions:patchQuestionSelection", sessionId, messageId, selectedAnswer),
  messageSubagent: (sessionId, message, options) =>
    ipcRenderer.invoke("sessions:messageSubagent", sessionId, message, options),
  sendReviewComments: (sessionId, message, options) =>
    ipcRenderer.invoke("sessions:sendReviewComments", sessionId, message, options),
  onSwitchTo: (callback) => {
    const handler = (_event, sessionId) => callback(sessionId);
    ipcRenderer.on("sessions:switch-to", handler);
    return () => ipcRenderer.removeListener("sessions:switch-to", handler);
  },
  onViewEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("session:view", handler);
    return () => ipcRenderer.removeListener("session:view", handler);
  },
  onStatusDelta: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("sessions:status-delta", handler);
    return () => ipcRenderer.removeListener("sessions:status-delta", handler);
  },
  onMetadataChanged: (callback) => {
    const handler = (_event, event) => {
      if (typeof event === "string") callback(event);
      else callback(event.sessionId, event.changes);
    };
    ipcRenderer.on("session:metadata-changed", handler);
    return () => ipcRenderer.removeListener("session:metadata-changed", handler);
  },
  onListChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("sessions:list-changed", handler);
    return () => ipcRenderer.removeListener("sessions:list-changed", handler);
  },
  onHydrationChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("sessions:hydration-changed", handler);
    return () => ipcRenderer.removeListener("sessions:hydration-changed", handler);
  },
});

contextBridge.exposeInMainWorld("modelsAPI", {
  list: () => ipcRenderer.invoke("models:list"),
  getDefault: () => ipcRenderer.invoke("models:getDefault"),
  setDefault: (model) => ipcRenderer.invoke("models:setDefault", model),
  getDefaultReasoningEffort: (model) =>
    ipcRenderer.invoke("models:getDefaultReasoningEffort", model),
  setDefaultReasoningEffort: (model, effort) =>
    ipcRenderer.invoke("models:setDefaultReasoningEffort", model, effort),
  getDefaultContextTier: (model) => ipcRenderer.invoke("models:getDefaultContextTier", model),
  setDefaultContextTier: (model, contextTier) =>
    ipcRenderer.invoke("models:setDefaultContextTier", model, contextTier),
  getSessionModel: (sessionId) => ipcRenderer.invoke("models:getSessionModel", sessionId),
  getSessionReasoningEffort: (sessionId) =>
    ipcRenderer.invoke("models:getSessionReasoningEffort", sessionId),
  setSessionReasoningEffort: (sessionId, effort) =>
    ipcRenderer.invoke("models:setSessionReasoningEffort", sessionId, effort),
  getSessionContextTier: (sessionId) =>
    ipcRenderer.invoke("models:getSessionContextTier", sessionId),
  setSessionContextTier: (sessionId, contextTier) =>
    ipcRenderer.invoke("models:setSessionContextTier", sessionId, contextTier),
  getTierDefaults: (tier) => ipcRenderer.invoke("models:getTierDefaults", tier),
  setTierDefaultModel: (tier, model) =>
    ipcRenderer.invoke("models:setTierDefaultModel", tier, model),
  setTierDefaultReasoningEffort: (tier, effort) =>
    ipcRenderer.invoke("models:setTierDefaultReasoningEffort", tier, effort),
  setTierDefaultContextTier: (tier, contextTier) =>
    ipcRenderer.invoke("models:setTierDefaultContextTier", tier, contextTier),
  onChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("models:changed", handler);
    return () => ipcRenderer.removeListener("models:changed", handler);
  },
});

contextBridge.exposeInMainWorld("soulAPI", {
  list: () => ipcRenderer.invoke("soul:list"),
  getDefault: () => ipcRenderer.invoke("soul:getDefault"),
  setDefault: (soul) => ipcRenderer.invoke("soul:setDefault", soul),
  getGreeting: (soulId) => ipcRenderer.invoke("soul:getGreeting", soulId),
  getSessionSoul: (sessionId) => ipcRenderer.invoke("soul:getSessionSoul", sessionId),
});

contextBridge.exposeInMainWorld("skillsAPI", {
  list: (sessionId) => ipcRenderer.invoke("skills:list", sessionId),
  add: (name, description, instructions, displayName) =>
    ipcRenderer.invoke("skills:add", name, description, instructions, displayName),
  update: (id, updates) => ipcRenderer.invoke("skills:update", id, updates),
  delete: (id) => ipcRenderer.invoke("skills:delete", id),
  export: (skillName) => ipcRenderer.invoke("skills:export", skillName),
  importFile: () => ipcRenderer.invoke("skills:import-file"),
  importPath: (filePath) => ipcRenderer.invoke("skills:import-path", filePath),
  importContents: (files) => ipcRenderer.invoke("skills:import-contents", files),
  importUrl: (url) => ipcRenderer.invoke("skills:import-url", url),
  importBundle: (dirPath) => ipcRenderer.invoke("skills:import-bundle", dirPath),
  openFile: (skillName) => ipcRenderer.invoke("skills:openFile", skillName),
  onChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("skills:changed", handler);
    return () => ipcRenderer.removeListener("skills:changed", handler);
  },
});

contextBridge.exposeInMainWorld("goalAPI", {
  get: (sessionId) => ipcRenderer.invoke("goal:get", sessionId),
  set: (sessionId, input) => ipcRenderer.invoke("goal:set", sessionId, input),
  updateDefinition: (sessionId, input) =>
    ipcRenderer.invoke("goal:updateDefinition", sessionId, input),
  updateContext: (sessionId, input) => ipcRenderer.invoke("goal:updateContext", sessionId, input),
  pause: (sessionId, expectedFence) => ipcRenderer.invoke("goal:pause", sessionId, expectedFence),
  resume: (sessionId, expectedFence) => ipcRenderer.invoke("goal:resume", sessionId, expectedFence),
  steer: (sessionId, input) => ipcRenderer.invoke("goal:steer", sessionId, input),
  stop: (sessionId, expectedFence) => ipcRenderer.invoke("goal:stop", sessionId, expectedFence),
  onChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("goal:changed", handler);
    return () => ipcRenderer.removeListener("goal:changed", handler);
  },
});

contextBridge.exposeInMainWorld("transcribeAPI", {
  audio: (audioBase64, mimeType) => ipcRenderer.invoke("transcribe:audio", audioBase64, mimeType),
});

contextBridge.exposeInMainWorld("settingsAPI", {
  get: () => ipcRenderer.invoke("settings:get"),
  getRuntimeSelection: () => ipcRenderer.invoke("settings:getRuntimeSelection"),
  switchRuntime: (runtimeId) => ipcRenderer.invoke("settings:switchRuntime", runtimeId),
  save: (settings) => ipcRenderer.invoke("settings:save", settings),
  getShowHideShortcutStatus: () => ipcRenderer.invoke("settings:getShowHideShortcutStatus"),
  pickWorkspaceDir: (defaultPath) => ipcRenderer.invoke("settings:pickWorkspaceDir", defaultPath),
  pickWorktreeDir: (defaultPath) => ipcRenderer.invoke("settings:pickWorktreeDir", defaultPath),
  openFile: () => ipcRenderer.invoke("settings:openFile"),
  onToggle: (callback) => {
    ipcRenderer.on("settings:toggle", callback);
    return () => ipcRenderer.removeListener("settings:toggle", callback);
  },
  onChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("settings:changed", handler);
    return () => ipcRenderer.removeListener("settings:changed", handler);
  },
});

contextBridge.exposeInMainWorld("relayProviderSettingsAPI", {
  list: () => ipcRenderer.invoke("relay-provider-settings:list"),
  connect: (request) => ipcRenderer.invoke("relay-provider-settings:connect", request),
  disconnect: (request) => ipcRenderer.invoke("relay-provider-settings:disconnect", request),
  reset: (request) => ipcRenderer.invoke("relay-provider-settings:reset", request),
  relink: (request) => ipcRenderer.invoke("relay-provider-settings:relink", request),
  provision: (request) => ipcRenderer.invoke("relay-provider-settings:provision", request),
  onChanged: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("relay-provider-settings:changed", handler);
    return () => ipcRenderer.removeListener("relay-provider-settings:changed", handler);
  },
  onSetupChanged: (callback) => {
    const handler = (_event, event) => callback(event);
    ipcRenderer.on("relay-provider-settings:setup-changed", handler);
    return () => ipcRenderer.removeListener("relay-provider-settings:setup-changed", handler);
  },
});

contextBridge.exposeInMainWorld("appAPI", {
  getDefaultWorkspaceDir: () => ipcRenderer.invoke("app:getDefaultWorkspaceDir"),
});

contextBridge.exposeInMainWorld("diagnosticsAPI", {
  rendererHeartbeat: (heartbeat) => ipcRenderer.invoke("diagnostics:rendererHeartbeat", heartbeat),
  log: (entry) => ipcRenderer.invoke("diagnostics:log", entry),
  getLogPath: () => ipcRenderer.invoke("diagnostics:getLogPath"),
  revealLogFolder: () => ipcRenderer.invoke("diagnostics:revealLogFolder"),
  sanitize: (text) => ipcRenderer.invoke("diagnostics:sanitize", text),
});

contextBridge.exposeInMainWorld("heartbeatAPI", {
  status: () => ipcRenderer.invoke("heartbeat:status"),
  toggle: (enable) => ipcRenderer.invoke("heartbeat:toggle", enable),
  getSettings: () => ipcRenderer.invoke("heartbeat:getSettings"),
  saveSettings: (updates) => ipcRenderer.invoke("heartbeat:saveSettings", updates),
  getLogs: (lines) => ipcRenderer.invoke("heartbeat:getLogs", lines),
  runNow: () => ipcRenderer.invoke("heartbeat:runNow"),
});

contextBridge.exposeInMainWorld("automationsAPI", {
  list: () => ipcRenderer.invoke("automations:list"),
  create: (data) => ipcRenderer.invoke("automations:create", data),
  update: (id, updates) => ipcRenderer.invoke("automations:update", id, updates),
  delete: (id, opts) => ipcRenderer.invoke("automations:delete", id, opts),
  toggle: (id, enabled) => ipcRenderer.invoke("automations:toggle", id, enabled),
  runNow: (id) => ipcRenderer.invoke("automations:runNow", id),
  getHistory: (id) => ipcRenderer.invoke("automations:getHistory", id),
  getAllHistory: () => ipcRenderer.invoke("automations:getAllHistory"),
  getCurrentRun: () => ipcRenderer.invoke("automations:getCurrentRun"),
  getConditionStatus: (id) => ipcRenderer.invoke("automations:getConditionStatus", id),
  exportAutomation: (id) => ipcRenderer.invoke("automations:export", id),
  importAutomation: (json) => ipcRenderer.invoke("automations:import", json),
  importBundle: () => ipcRenderer.invoke("automations:importBundle"),
  importFromGithub: (url, token) => ipcRenderer.invoke("automations:importFromGithub", url, token),
  onChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("automations:changed", handler);
    return () => ipcRenderer.removeListener("automations:changed", handler);
  },
});

// ── workflowsAPI (Dynamic Workflows V1) ─────────────────────────────────────
// Handlers added in main by IMPL-ENGINE. Renderer code handles missing
// handlers gracefully so the panel renders empty states in dev.
contextBridge.exposeInMainWorld("workflowsAPI", {
  list: (repoPath, workspaceName) => ipcRenderer.invoke("workflows:list", repoPath, workspaceName),
  listRuns: (workflowId, repoPath) =>
    ipcRenderer.invoke("workflows:listRuns", workflowId, repoPath),
  getRunForHostSession: (hostSessionId) =>
    ipcRenderer.invoke("workflows:getRunForHostSession", hostSessionId),
  getRun: (runId) => ipcRenderer.invoke("workflows:getRun", runId),
  getEvents: (runId, fromSeq) => ipcRenderer.invoke("workflows:getEvents", runId, fromSeq),
  run: (workflowId, input, repoPath) =>
    ipcRenderer.invoke("workflows:run", workflowId, input, repoPath),
  cancel: (runId, reason) => ipcRenderer.invoke("workflows:cancel", runId, reason),
  retryFromStep: (runId, stepId) => ipcRenderer.invoke("workflows:retryFromStep", runId, stepId),
  installLocal: (sourceDir, overwrite) =>
    ipcRenderer.invoke("workflows:installLocal", sourceDir, overwrite),
  pickInstallDir: () => ipcRenderer.invoke("workflows:pickInstallDir"),
  updateSchedule: (workflowId, schedule, input, repoPath) =>
    ipcRenderer.invoke("workflows:updateSchedule", workflowId, schedule, input, repoPath),
  disableSchedule: (workflowId, repoPath) =>
    ipcRenderer.invoke("workflows:disableSchedule", workflowId, repoPath),
  getRenderer: (workflowId, repoPath) =>
    ipcRenderer.invoke("workflows:getRenderer", workflowId, repoPath),
  getCommandCenter: (workflowId, repoPath) =>
    ipcRenderer.invoke("workflows:getCommandCenter", workflowId, repoPath),
  readArtifact: (runId, storageKey) =>
    ipcRenderer.invoke("workflows:readArtifact", runId, storageKey),
  listArtifacts: (workflowId, repoPath, prefix, limit) =>
    ipcRenderer.invoke("workflows:listArtifacts", workflowId, repoPath, prefix, limit),
  listState: (workflowId, repoPath, prefix) =>
    ipcRenderer.invoke("workflows:listState", workflowId, repoPath, prefix),
  readState: (workflowId, key, repoPath) =>
    ipcRenderer.invoke("workflows:readState", workflowId, key, repoPath),
  compactState: (workflowId, repoPath, prefix, olderThanMs, limit) =>
    ipcRenderer.invoke("workflows:compactState", workflowId, repoPath, prefix, olderThanMs, limit),
  clearState: (request) => ipcRenderer.invoke("workflows:clearState", request),
  readArtifactByKey: (runId, key) => ipcRenderer.invoke("workflows:readArtifactByKey", runId, key),
  getStateValue: (workflowId, key) =>
    ipcRenderer.invoke("workflows:getStateValue", workflowId, key),
  listStateKeys: (workflowId, prefix) =>
    ipcRenderer.invoke("workflows:listStateKeys", workflowId, prefix),
  putConfigValue: (workflowId, key, value, repoPath) =>
    ipcRenderer.invoke("workflows:putConfigValue", workflowId, key, value, repoPath),
  permissionResponse: (response) => ipcRenderer.invoke("workflows:permissionResponse", response),

  subscribeRunEvents: (runId, callback) => {
    const channel = `workflows:run-events:${runId}`;
    const handler = (_event, batch) => callback(batch);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  subscribeRunStatus: (runId, callback) => {
    const channel = `workflows:run-status:${runId}`;
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  subscribeRunTick: (runId, callback) => {
    const channel = `workflows:run-tick:${runId}`;
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  subscribePermissionRequests: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("workflow:permission-request", handler);
    return () => ipcRenderer.removeListener("workflow:permission-request", handler);
  },
});

contextBridge.exposeInMainWorld("commandCenterAPI", {
  getSnapshot: () => ipcRenderer.invoke("command-center:getSnapshot"),
  refresh: () => ipcRenderer.invoke("command-center:refresh"),
  upsertTodo: (todo) => ipcRenderer.invoke("command-center:upsertTodo", todo),
  deleteTodo: (todoId) => ipcRenderer.invoke("command-center:deleteTodo", todoId),
  openSession: (safeSessionId) => ipcRenderer.invoke("command-center:openSession", safeSessionId),
  getSessionActivity: (sessionId) =>
    ipcRenderer.invoke("command-center:getSessionActivity", sessionId),
  onSnapshot: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("command-center:snapshot", handler);
    return () => ipcRenderer.removeListener("command-center:snapshot", handler);
  },
});

contextBridge.exposeInMainWorld("updateAPI", {
  auth: () => ipcRenderer.invoke("update:auth"),
  clearToken: () => ipcRenderer.invoke("update:clear-token"),
  check: () => ipcRenderer.invoke("update:check"),
  download: (url, assetName) => ipcRenderer.invoke("update:download", url, assetName),
  install: (filePath) => ipcRenderer.invoke("update:install", filePath),
  restart: (installerPath) => ipcRenderer.invoke("update:restart", installerPath),
  checkMinimum: () => ipcRenderer.invoke("update:check-minimum"),
  onProgress: (callback) => {
    const handler = (_event, percent) => callback(percent);
    ipcRenderer.on("update:progress", handler);
    return () => ipcRenderer.removeListener("update:progress", handler);
  },
  onDeviceFlow: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("update:device-flow", handler);
    return () => ipcRenderer.removeListener("update:device-flow", handler);
  },
  onTriggerCheck: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("update:trigger-check", handler);
    return () => ipcRenderer.removeListener("update:trigger-check", handler);
  },
});

contextBridge.exposeInMainWorld("platform", process.platform);
// App mode ("dev", "beta", or "release").
// A single preload-scope listener captures app:modeChanged events (registered
// before React) so `getLatest()` always returns the current value even if the
// hook mounts after the first event. Renderer callbacks are fanned out from
// the same listener — only one IPC subscription on this channel.
let latestMode = process.env.MARSHAL_APP_MODE || "release";
const modeCallbacks = new Set();
ipcRenderer.on("app:modeChanged", (_event, mode) => {
  latestMode = mode;
  modeCallbacks.forEach((cb) => cb(mode));
});
contextBridge.exposeInMainWorld("appModeAPI", {
  getLatest: () => latestMode,
  onModeChanged: (callback) => {
    modeCallbacks.add(callback);
    return () => modeCallbacks.delete(callback);
  },
});

contextBridge.exposeInMainWorld("backgroundAPI", {
  getSettings: () => ipcRenderer.invoke("background:getSettings"),
  saveSettings: (updates) => ipcRenderer.invoke("background:saveSettings", updates),
});

contextBridge.exposeInMainWorld("windowControlsAPI", {
  getState: () => ipcRenderer.invoke("window-controls:getState"),
  minimize: () => ipcRenderer.invoke("window-controls:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window-controls:toggleMaximize"),
  close: () => ipcRenderer.invoke("window-controls:close"),
  setWidth: (width) => ipcRenderer.invoke("window-controls:setWidth", width),
  onMaximizeChanged: (callback) => {
    const handler = (_event, isMaximized) => callback(isMaximized);
    ipcRenderer.on("window-controls:maximized-changed", handler);
    return () => ipcRenderer.removeListener("window-controls:maximized-changed", handler);
  },
  onFullScreenChanged: (callback) => {
    const handler = (_event, isFullScreen) => callback(isFullScreen);
    ipcRenderer.on("window-controls:fullscreen-changed", handler);
    return () => ipcRenderer.removeListener("window-controls:fullscreen-changed", handler);
  },
});

// "Open in New Window" for chats.
contextBridge.exposeInMainWorld("chatWindowsAPI", {
  open: (sessionId, bounds) => ipcRenderer.invoke("chat-windows:open", sessionId, bounds),
});

contextBridge.exposeInMainWorld("mcpsAPI", {
  initiateOAuth: (serverName, loginHint, options) =>
    ipcRenderer.invoke("mcps:initiateOAuth", serverName, loginHint, options),
  list: () => ipcRenderer.invoke("mcps:list"),
  signOut: (serverName) => ipcRenderer.invoke("mcps:signOut", serverName),
  add: (input) => ipcRenderer.invoke("mcps:add", input),
  installCatalog: (input) => ipcRenderer.invoke("mcps:install-catalog", input),
  remove: (name) => ipcRenderer.invoke("mcps:remove", name),
  updateConfig: (input) => ipcRenderer.invoke("mcps:update-config", input),
  openFile: () => ipcRenderer.invoke("mcps:openFile"),
  rediscover: () => ipcRenderer.invoke("mcps:rediscover"),
  setExposeAsGatewayNodeCommand: (name, expose) =>
    ipcRenderer.invoke("mcps:setExposeAsGatewayNodeCommand", name, expose),
  openEnvFile: (serverKey, target) => ipcRenderer.invoke("mcps:openEnvFile", serverKey, target),
  onToolsUpdated: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("mcp:tools-updated", handler);
    return () => ipcRenderer.removeListener("mcp:tools-updated", handler);
  },
  onServerStatus: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("mcp:server-status", handler);
    return () => ipcRenderer.removeListener("mcp:server-status", handler);
  },
  onOAuthRequired: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("mcp:oauth-required", handler);
    return () => ipcRenderer.removeListener("mcp:oauth-required", handler);
  },
  onOAuthCompleted: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("mcp:oauth-completed", handler);
    return () => ipcRenderer.removeListener("mcp:oauth-completed", handler);
  },
});

contextBridge.exposeInMainWorld("tenantAPI", {
  getStatus: () => ipcRenderer.invoke("tenant:getStatus"),
  onPolicyChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("tenant:policyChanged", handler);
    return () => ipcRenderer.removeListener("tenant:policyChanged", handler);
  },
});

contextBridge.exposeInMainWorld("activitiesAPI", {
  getAll: (logLines) => ipcRenderer.invoke("activities:getAll", logLines),
});

contextBridge.exposeInMainWorld("permissionsAPI", {
  getCards: (sessionId) => ipcRenderer.invoke("permissions:get-cards", sessionId),
  clearCards: (sessionId) => ipcRenderer.invoke("permissions:clear-cards", sessionId),
  listTools: () => ipcRenderer.invoke("permissions:list-tools"),
  getConfig: () => ipcRenderer.invoke("permissions:get-config"),
  saveConfig: (patch) => ipcRenderer.invoke("permissions:save-config", patch),
  onCardsChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("permissions:cards-changed", handler);
    return () => ipcRenderer.removeListener("permissions:cards-changed", handler);
  },
});

contextBridge.exposeInMainWorld("contextPickerAPI", {
  search: (query, entityTypes) => ipcRenderer.invoke("contextPicker:search", query, entityTypes),
});

contextBridge.exposeInMainWorld("workspaceAPI", {
  getRoot: (workspaceName) => ipcRenderer.invoke("workspace:getRoot", workspaceName),
  listDir: (dirPath) => ipcRenderer.invoke("workspace:listDir", dirPath),
  searchFiles: (workspaceName, query) =>
    ipcRenderer.invoke("workspace:searchFiles", workspaceName, query),
  readFile: (filePath, readCapability) =>
    ipcRenderer.invoke("workspace:readFile", filePath, readCapability),
  writeFile: (filePath, content) => ipcRenderer.invoke("workspace:writeFile", filePath, content),
  revealInFileManager: (targetPath, readCapability) =>
    ipcRenderer.invoke("workspace:revealInFileManager", targetPath, readCapability),
  openFile: (targetPath, readCapability) =>
    ipcRenderer.invoke("workspace:openFile", targetPath, readCapability),
  onWorkspaceChange: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("workspace:changed", listener);
    return () => ipcRenderer.removeListener("workspace:changed", listener);
  },
  onWorkspaceRegistryChange: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("workspace:registry-changed", listener);
    return () => ipcRenderer.removeListener("workspace:registry-changed", listener);
  },
  listWorkspaces: () => ipcRenderer.invoke("workspace:listWorkspaces"),
  listRepositoryAgents: (workspaceName) =>
    ipcRenderer.invoke("workspace:listRepositoryAgents", workspaceName),
  createWorkspace: (name, externalPickToken) =>
    ipcRenderer.invoke("workspace:createWorkspace", name, externalPickToken),
  pickFolder: () => ipcRenderer.invoke("workspace:pickFolder"),
  renameWorkspace: (oldName, newName) =>
    ipcRenderer.invoke("workspace:renameWorkspace", oldName, newName),
  deleteWorkspace: (name) => ipcRenderer.invoke("workspace:deleteWorkspace", name),
  getWorkspaceContents: (name) => ipcRenderer.invoke("workspace:getWorkspaceContents", name),
  createFolder: (parentPath, name) =>
    ipcRenderer.invoke("workspace:createFolder", parentPath, name),
  renameItem: (itemPath, newName) => ipcRenderer.invoke("workspace:renameItem", itemPath, newName),
  deleteItem: (itemPath) => ipcRenderer.invoke("workspace:deleteItem", itemPath),
  moveItem: (sourcePath, destDir) => ipcRenderer.invoke("workspace:moveItem", sourcePath, destDir),
  duplicateItem: (sourcePath, destPath) =>
    ipcRenderer.invoke("workspace:duplicateItem", sourcePath, destPath),
  copyExternalFiles: async (files, destDir) => {
    const paths = getNativePathsForFiles(files);
    const registration = await externalFileImportBridgeRegistration;
    if (!registration?.success) return registration;
    const authorized = await ipcRenderer.invoke(
      "workspace:authorizeExternalFiles",
      externalFileImportBridgeToken,
      paths,
    );
    if (!authorized?.success || !authorized.importToken) return authorized;
    return ipcRenderer.invoke("workspace:copyExternalFiles", authorized.importToken, destDir);
  },
  getUIState: () => ipcRenderer.invoke("workspace:getUIState"),
  setActiveWorkspace: (name) => ipcRenderer.invoke("workspace:setActiveWorkspace", name),
  setExpandedPaths: (workspaceName, relativePaths) =>
    ipcRenderer.invoke("workspace:setExpandedPaths", workspaceName, relativePaths),
  setSelectedFile: (workspaceName, relativePath) =>
    ipcRenderer.invoke("workspace:setSelectedFile", workspaceName, relativePath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
});

contextBridge.exposeInMainWorld("encryptionAPI", {
  wasKeyReset: () => ipcRenderer.invoke("encryption:wasKeyReset"),
});

contextBridge.exposeInMainWorld("shellAPI", {
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  quitApp: () => ipcRenderer.invoke("shell:quitApp"),
  onFileOpenError: (callback) => {
    const handler = (_event, error) => callback(error);
    ipcRenderer.on("file:openError", handler);
    return () => ipcRenderer.removeListener("file:openError", handler);
  },
});

contextBridge.exposeInMainWorld("preferencesAPI", {
  get: (key) => ipcRenderer.invoke("preferences:get", key),
  set: (key, value) => ipcRenderer.invoke("preferences:set", key, value),
});

contextBridge.exposeInMainWorld("fileExportAPI", {
  saveJson: (content, defaultFilename) =>
    ipcRenderer.invoke("file:saveJson", content, defaultFilename),
});

contextBridge.exposeInMainWorld("backendAPI", {
  capabilities: () => ipcRenderer.invoke("backend:capabilities"),
});

contextBridge.exposeInMainWorld("runtimeAuthAPI", {
  getStatus: () => ipcRenderer.invoke("runtimeAuth:getStatus"),
  login: (request) => ipcRenderer.invoke("runtimeAuth:login", request),
  signOut: () => ipcRenderer.invoke("runtimeAuth:signOut"),
  onAuthError: (callback) => {
    const handler = (_event, error) => callback(error);
    ipcRenderer.on("runtimeAuth:authError", handler);
    return () => ipcRenderer.removeListener("runtimeAuth:authError", handler);
  },
  onLoginFailed: (callback) => {
    const handler = (_event, reason) => callback(reason);
    ipcRenderer.on("runtimeAuth:loginFailed", handler);
    return () => ipcRenderer.removeListener("runtimeAuth:loginFailed", handler);
  },
});

contextBridge.exposeInMainWorld("runtimeAccountsAPI", {
  list: () => ipcRenderer.invoke("runtimeAccounts:list"),
  add: (runtimeId, label) => ipcRenderer.invoke("runtimeAccounts:add", runtimeId, label),
  rename: (runtimeId, accountId, label) =>
    ipcRenderer.invoke("runtimeAccounts:rename", runtimeId, accountId, label),
  remove: (runtimeId, accountId) =>
    ipcRenderer.invoke("runtimeAccounts:remove", runtimeId, accountId),
  setDefault: (runtimeId, accountId) =>
    ipcRenderer.invoke("runtimeAccounts:setDefault", runtimeId, accountId),
  getStatus: (runtimeId, accountId) =>
    ipcRenderer.invoke("runtimeAccounts:getStatus", runtimeId, accountId),
  getUsage: (runtimeId, accountId, options) =>
    ipcRenderer.invoke("runtimeAccounts:getUsage", runtimeId, accountId, options),
  login: (runtimeId, accountId, request) =>
    ipcRenderer.invoke("runtimeAccounts:login", runtimeId, accountId, request),
  signOut: (runtimeId, accountId) =>
    ipcRenderer.invoke("runtimeAccounts:signOut", runtimeId, accountId),
});

contextBridge.exposeInMainWorld("uiObserveAPI", {
  // Observe harness readiness signal (ui.observe.capture): consumed only for
  // windows the capture module registered; a no-op elsewhere.
  ready: (info) => ipcRenderer.send("ui-observe:ready", info ?? {}),
});

contextBridge.exposeInMainWorld("runtimeUiAPI", {
  getEvidence: (request) => ipcRenderer.invoke("runtime-ui:getEvidence", request),
  openEvidence: (request) => ipcRenderer.invoke("runtime-ui:openEvidence", request),
  getSnapshot: (request) => ipcRenderer.invoke("runtime-ui:getSnapshot", request),
  subscribe: (request) => ipcRenderer.invoke("runtime-ui:subscribe", request),
  unsubscribe: (scope) => ipcRenderer.invoke("runtime-ui:unsubscribe", scope),
  open: (request) => ipcRenderer.invoke("runtime-ui:open", request),
  update: (request) => ipcRenderer.invoke("runtime-ui:update", request),
  focus: (request) => ipcRenderer.invoke("runtime-ui:focus", request),
  close: (request) => ipcRenderer.invoke("runtime-ui:close", request),
  list: (request) => ipcRenderer.invoke("runtime-ui:list", request),
  getPlacements: (request) => ipcRenderer.invoke("runtime-ui:getPlacements", request),
  activatePlacement: (request) => ipcRenderer.invoke("runtime-ui:activatePlacement", request),
  invokeCapability: (request) => ipcRenderer.invoke("runtime-ui:invokeCapability", request),
  cancelCapability: (request) => ipcRenderer.invoke("runtime-ui:cancelCapability", request),
  selectSession: (request) => ipcRenderer.invoke("runtime-ui:selectSession", request),
  getSelectedSession: (request) => ipcRenderer.invoke("runtime-ui:getSelectedSession", request),
  searchSessions: (request) => ipcRenderer.invoke("runtime-ui:searchSessions", request),
  selectImages: (request) => ipcRenderer.invoke("runtime-ui:selectImages", request),
  listImages: (request) => ipcRenderer.invoke("runtime-ui:listImages", request),
  readImage: (request) => ipcRenderer.invoke("runtime-ui:readImage", request),
  releaseImage: (request) => ipcRenderer.invoke("runtime-ui:releaseImage", request),
  readResource: (request) => ipcRenderer.invoke("runtime-ui:readResource", request),
  getLayout: (request) => ipcRenderer.invoke("runtime-ui:getLayout", request),
  saveLayout: (request) => ipcRenderer.invoke("runtime-ui:saveLayout", request),
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("runtime-ui:event", handler);
    return () => ipcRenderer.removeListener("runtime-ui:event", handler);
  },
});

contextBridge.exposeInMainWorld("runtimeExtensionsAPI", {
  search: (request) => ipcRenderer.invoke("runtime-extensions:search", request),
  status: (request) => ipcRenderer.invoke("runtime-extensions:status", request),
  install: (request) => ipcRenderer.invoke("runtime-extensions:install", request),
  installLocal: (request) => ipcRenderer.invoke("runtime-extensions:installLocal", request),
  update: (request) => ipcRenderer.invoke("runtime-extensions:update", request),
  enable: (request) => ipcRenderer.invoke("runtime-extensions:enable", request),
  disable: (request) => ipcRenderer.invoke("runtime-extensions:disable", request),
  configure: (request) => ipcRenderer.invoke("runtime-extensions:configure", request),
  setProvider: (request) => ipcRenderer.invoke("runtime-extensions:setProvider", request),
  clearProvider: (request) => ipcRenderer.invoke("runtime-extensions:clearProvider", request),
  repairContractConflict: (request) =>
    ipcRenderer.invoke("runtime-extensions:repairContractConflict", request),
  remove: (request) => ipcRenderer.invoke("runtime-extensions:remove", request),
  onChanged: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("runtime-extensions:changed", handler);
    return () => ipcRenderer.removeListener("runtime-extensions:changed", handler);
  },
});

contextBridge.exposeInMainWorld("aiInvestigatorAPI", {
  checkAvailability: () => ipcRenderer.invoke("aiInvestigator:checkAvailability"),
  start: (input) => ipcRenderer.invoke("aiInvestigator:start", input),
  getStatus: () => ipcRenderer.invoke("aiInvestigator:getStatus"),
  cancel: () => ipcRenderer.invoke("aiInvestigator:cancel"),
  reset: () => ipcRenderer.invoke("aiInvestigator:reset"),
  post: () => ipcRenderer.invoke("aiInvestigator:post"),
  onEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("aiInvestigator:event", handler);
    return () => ipcRenderer.removeListener("aiInvestigator:event", handler);
  },
});

// Dev-only API — devAPI is always exposed but setMockMode is a no-op
// in production (the main process handler is only registered in dev builds).
contextBridge.exposeInMainWorld("devAPI", {
  getMockMode: () => ipcRenderer.invoke("dev:getMockMode"),
  setMockMode: (enabled) => ipcRenderer.invoke("dev:setMockMode", enabled),
  testMiniModeNotification: (type, delayMs) =>
    ipcRenderer.invoke("dev:testMiniModeNotification", type, delayMs),
});

contextBridge.exposeInMainWorld("gatewayAuthAPI", {
  getState: () => ipcRenderer.invoke("gatewayAuth:getState"),
  signIn: (cred) => ipcRenderer.invoke("gatewayAuth:signIn", cred),
  signOut: () => ipcRenderer.invoke("gatewayAuth:signOut"),
  cancelPairing: () => ipcRenderer.invoke("gatewayAuth:cancelPairing"),
  listPendingDevices: () => ipcRenderer.invoke("gatewayAuth:listPendingDevices"),
  approveDevice: (requestId) => ipcRenderer.invoke("gatewayAuth:approveDevice", requestId),
  onStateChange: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("gatewayAuth:stateChange", handler);
    return () => ipcRenderer.removeListener("gatewayAuth:stateChange", handler);
  },
});

contextBridge.exposeInMainWorld("gatewayNodeAPI", {
  getActivity: () => ipcRenderer.invoke("gatewayNode:getActivity"),
  onActivity: (callback) => {
    const handler = (_event, entry) => callback(entry);
    ipcRenderer.on("gatewayNode:activity", handler);
    return () => ipcRenderer.removeListener("gatewayNode:activity", handler);
  },
});

contextBridge.exposeInMainWorld("identityAPI", {
  get: () => ipcRenderer.invoke("identity:get"),
  onChange: (callback) => {
    const handler = (_event, identity) => callback(identity);
    ipcRenderer.on("identity:change", handler);
    return () => ipcRenderer.removeListener("identity:change", handler);
  },
});

contextBridge.exposeInMainWorld("telemetryAPI", {
  writeLocalEvent: (event) => ipcRenderer.invoke("telemetry:write-local-event", event),
  deleteLocalData: () => ipcRenderer.invoke("telemetry:delete-local-data"),
  rendererFinalized: () => ipcRenderer.invoke("telemetry:renderer-finalized"),
  onLogError: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("telemetry:logError", handler);
    return () => ipcRenderer.removeListener("telemetry:logError", handler);
  },
  onLogEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("telemetry:logEvent", handler);
    return () => ipcRenderer.removeListener("telemetry:logEvent", handler);
  },
  onFinalize: (callback) => {
    ipcRenderer.on("telemetry:finalize", callback);
    return () => ipcRenderer.removeListener("telemetry:finalize", callback);
  },
});

contextBridge.exposeInMainWorld("remoteAccessAPI", {
  setupTailscale: () => ipcRenderer.invoke("remote-access:setupTailscale"),
  getState: () => ipcRenderer.invoke("remote-access:getState"),
  configure: (input) => ipcRenderer.invoke("remote-access:configure", input),
});
