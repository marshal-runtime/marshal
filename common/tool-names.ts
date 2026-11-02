export const FIRST_PARTY_TOOL_NAMES = {
  listRunningTools: "listRunningTools",
  inspectRunningTool: "inspectRunningTool",
  cancelRunningTool: "cancelRunningTool",
  listAutomations: "listAutomations",
  getAutomation: "getAutomation",
  createAutomation: "createAutomation",
  updateAutomation: "updateAutomation",
  deleteAutomation: "deleteAutomation",
  runAutomationNow: "runAutomationNow",
  listModels: "listModels",
  setDefaultModel: "setDefaultModel",
  getCurrentModel: "getCurrentModel",
  listSouls: "listSouls",
  setSoul: "setSoul",
  getSettings: "getSettings",
  updateSettings: "updateSettings",
  requestPermissionEscalation: "requestPermissionEscalation",
  remember: "remember",
  recall: "recall",
  listMemories: "listMemories",
  forget: "forget",
  searchSessions: "searchSessions",
  getSessionTranscript: "getSessionTranscript",
  setSessionTodos: "setSessionTodos",
  publishRelayMessage: "publishRelayMessage",
  listWorkspaces: "listWorkspaces",
  registerWorkspace: "registerWorkspace",
  listRepositoryAgents: "listRepositoryAgents",
  spawnSubagent: "spawnSubagent",
  spawnSubagents: "spawnSubagents",
  workflowList: "workflowList",
  workflowRun: "workflowRun",
  workflowGetRun: "workflowGetRun",
  workflowListState: "workflowListState",
  workflowReadState: "workflowReadState",
  workflowListArtifacts: "workflowListArtifacts",
  workflowReadArtifact: "workflowReadArtifact",
  workflowSaveArtifact: "workflowSaveArtifact",
  workflowCancel: "workflowCancel",
  workflowRetryFromStep: "workflowRetryFromStep",
  workflowDescribe: "workflowDescribe",
  listSubagents: "listSubagents",
  messageSubagent: "messageSubagent",
  cancelQueuedSubagentMessages: "cancelQueuedSubagentMessages",
  messageParent: "messageParent",
  deleteSession: "deleteSession",
  sendNotification: "sendNotification",
  listSkills: "listSkills",
  getSkill: "getSkill",
  createSkill: "createSkill",
  updateSkill: "updateSkill",
  deleteSkill: "deleteSkill",
  notificationStatus: "notificationStatus",
  connectNotifications: "connectNotifications",
  disconnectNotifications: "disconnectNotifications",
  askUser: "askUser",
  sleep: "sleep",
  goalGet: "goalGet",
  goalSet: "goalSet",
  goalUpdateDefinition: "goalUpdateDefinition",
  goalUpdateContext: "goalUpdateContext",
  goalProposeTransition: "goalProposeTransition",
  goalRunValidation: "goalRunValidation",
  listLocalFiles: "listLocalFiles",
  getLocalFileTree: "getLocalFileTree",
  statLocalPath: "statLocalPath",
  createLocalDirectory: "createLocalDirectory",
  moveLocalPath: "moveLocalPath",
} as const;

export type FirstPartyToolName =
  (typeof FIRST_PARTY_TOOL_NAMES)[keyof typeof FIRST_PARTY_TOOL_NAMES];

const TOOL_NAME_TOKEN_PATTERN =
  /[A-Z]{2}[a-z]+\d*(?=[A-Z]|$)|[A-Z]{2,}s(?=[A-Z]|$)|[A-Z]{2,}\d*(?=[A-Z][a-z]|$)|[A-Z]?[a-z]+\d*|[A-Z]+\d*|\d+/g;

function isAcronymStyle(word: string): boolean {
  return (
    (/^[A-Z0-9]+$/.test(word) && /[A-Z]/.test(word)) || (word.match(/[A-Z]/g)?.length ?? 0) >= 2
  );
}

function toolNameWords(name: string): string[] {
  const leafName =
    name
      .trim()
      .split(/__|[:./]/)
      .filter(Boolean)
      .at(-1) ?? "";
  return leafName
    .split(/[_\s-]+/)
    .filter(Boolean)
    .flatMap((word) => word.match(TOOL_NAME_TOKEN_PATTERN) ?? [word])
    .map((word) => (isAcronymStyle(word) ? word : word.toLowerCase()));
}

function capitalizeToolNameWord(word: string): string {
  return isAcronymStyle(word) ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

export function humanizeToolName(name: unknown): string {
  if (typeof name !== "string") return "";
  const [first, ...rest] = toolNameWords(name);
  if (!first) return "";
  return [capitalizeToolNameWord(first), ...rest].join(" ");
}

export const PUBLIC_SELF_TOOL_NAMES = [
  FIRST_PARTY_TOOL_NAMES.listRunningTools,
  FIRST_PARTY_TOOL_NAMES.inspectRunningTool,
  FIRST_PARTY_TOOL_NAMES.cancelRunningTool,
  FIRST_PARTY_TOOL_NAMES.listAutomations,
  FIRST_PARTY_TOOL_NAMES.getAutomation,
  FIRST_PARTY_TOOL_NAMES.createAutomation,
  FIRST_PARTY_TOOL_NAMES.updateAutomation,
  FIRST_PARTY_TOOL_NAMES.deleteAutomation,
  FIRST_PARTY_TOOL_NAMES.runAutomationNow,
  FIRST_PARTY_TOOL_NAMES.listModels,
  FIRST_PARTY_TOOL_NAMES.setDefaultModel,
  FIRST_PARTY_TOOL_NAMES.getCurrentModel,
  FIRST_PARTY_TOOL_NAMES.listSouls,
  FIRST_PARTY_TOOL_NAMES.setSoul,
  FIRST_PARTY_TOOL_NAMES.getSettings,
  FIRST_PARTY_TOOL_NAMES.updateSettings,
  FIRST_PARTY_TOOL_NAMES.requestPermissionEscalation,
  FIRST_PARTY_TOOL_NAMES.remember,
  FIRST_PARTY_TOOL_NAMES.recall,
  FIRST_PARTY_TOOL_NAMES.listMemories,
  FIRST_PARTY_TOOL_NAMES.forget,
  FIRST_PARTY_TOOL_NAMES.searchSessions,
  FIRST_PARTY_TOOL_NAMES.getSessionTranscript,
  FIRST_PARTY_TOOL_NAMES.setSessionTodos,
  FIRST_PARTY_TOOL_NAMES.publishRelayMessage,
  FIRST_PARTY_TOOL_NAMES.listWorkspaces,
  FIRST_PARTY_TOOL_NAMES.registerWorkspace,
  FIRST_PARTY_TOOL_NAMES.listRepositoryAgents,
  FIRST_PARTY_TOOL_NAMES.spawnSubagent,
  FIRST_PARTY_TOOL_NAMES.spawnSubagents,
  FIRST_PARTY_TOOL_NAMES.workflowList,
  FIRST_PARTY_TOOL_NAMES.workflowRun,
  FIRST_PARTY_TOOL_NAMES.workflowGetRun,
  FIRST_PARTY_TOOL_NAMES.workflowListState,
  FIRST_PARTY_TOOL_NAMES.workflowReadState,
  FIRST_PARTY_TOOL_NAMES.workflowListArtifacts,
  FIRST_PARTY_TOOL_NAMES.workflowReadArtifact,
  FIRST_PARTY_TOOL_NAMES.workflowSaveArtifact,
  FIRST_PARTY_TOOL_NAMES.workflowCancel,
  FIRST_PARTY_TOOL_NAMES.workflowRetryFromStep,
  FIRST_PARTY_TOOL_NAMES.workflowDescribe,
  FIRST_PARTY_TOOL_NAMES.listSubagents,
  FIRST_PARTY_TOOL_NAMES.messageSubagent,
  FIRST_PARTY_TOOL_NAMES.cancelQueuedSubagentMessages,
  FIRST_PARTY_TOOL_NAMES.messageParent,
  FIRST_PARTY_TOOL_NAMES.deleteSession,
  FIRST_PARTY_TOOL_NAMES.sendNotification,
  FIRST_PARTY_TOOL_NAMES.listSkills,
  FIRST_PARTY_TOOL_NAMES.getSkill,
  FIRST_PARTY_TOOL_NAMES.createSkill,
  FIRST_PARTY_TOOL_NAMES.updateSkill,
  FIRST_PARTY_TOOL_NAMES.deleteSkill,
  FIRST_PARTY_TOOL_NAMES.notificationStatus,
  FIRST_PARTY_TOOL_NAMES.connectNotifications,
  FIRST_PARTY_TOOL_NAMES.disconnectNotifications,
  FIRST_PARTY_TOOL_NAMES.askUser,
  FIRST_PARTY_TOOL_NAMES.sleep,
  FIRST_PARTY_TOOL_NAMES.goalGet,
  FIRST_PARTY_TOOL_NAMES.goalSet,
  FIRST_PARTY_TOOL_NAMES.goalUpdateDefinition,
  FIRST_PARTY_TOOL_NAMES.goalUpdateContext,
  FIRST_PARTY_TOOL_NAMES.goalProposeTransition,
] as const;

export const LOCAL_FILE_TOOL_NAMES = [
  FIRST_PARTY_TOOL_NAMES.listLocalFiles,
  FIRST_PARTY_TOOL_NAMES.getLocalFileTree,
  FIRST_PARTY_TOOL_NAMES.statLocalPath,
  FIRST_PARTY_TOOL_NAMES.createLocalDirectory,
  FIRST_PARTY_TOOL_NAMES.moveLocalPath,
] as const;

export const RETIRED_FIRST_PARTY_TOOL_NAMES = [
  "getHeartbeatStatus",
  "setHeartbeatSettings",
  "runHeartbeatNow",
  "workflowInstall",
  "workflowInstallLocal",
] as const;

export const ALL_PUBLIC_FIRST_PARTY_TOOL_NAMES = [
  ...PUBLIC_SELF_TOOL_NAMES,
  ...LOCAL_FILE_TOOL_NAMES,
] as const;

const publicToolNameSet = new Set<string>(ALL_PUBLIC_FIRST_PARTY_TOOL_NAMES);
const localFileToolNameSet = new Set<string>(LOCAL_FILE_TOOL_NAMES);
const retiredToolNameSet = new Set<string>(RETIRED_FIRST_PARTY_TOOL_NAMES);

export function isPublicFirstPartyToolName(name: string): name is FirstPartyToolName {
  return publicToolNameSet.has(name);
}

export function isLocalFileToolName(name: string): name is FirstPartyToolName {
  return localFileToolNameSet.has(name);
}

export function isRetiredFirstPartyToolName(name: string): boolean {
  return retiredToolNameSet.has(name);
}

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const legacySelfNameOverrides: Readonly<Record<string, string>> = {
  [FIRST_PARTY_TOOL_NAMES.notificationStatus]: "marshal_relay_status",
  [FIRST_PARTY_TOOL_NAMES.connectNotifications]: "marshal_relay_connect",
  [FIRST_PARTY_TOOL_NAMES.disconnectNotifications]: "marshal_relay_disconnect",
};

const legacyLocalFileNames: Readonly<Record<string, string>> = {
  marshal_filesystem_list: FIRST_PARTY_TOOL_NAMES.listLocalFiles,
  marshal_filesystem_tree: FIRST_PARTY_TOOL_NAMES.getLocalFileTree,
  marshal_filesystem_stat: FIRST_PARTY_TOOL_NAMES.statLocalPath,
  marshal_filesystem_mkdir: FIRST_PARTY_TOOL_NAMES.createLocalDirectory,
  marshal_filesystem_move: FIRST_PARTY_TOOL_NAMES.moveLocalPath,
};

const retiredLegacySelfNames: Readonly<Record<string, string>> = {
  marshal_get_heartbeat_status: RETIRED_FIRST_PARTY_TOOL_NAMES[0],
  marshal_set_heartbeat_settings: RETIRED_FIRST_PARTY_TOOL_NAMES[1],
  marshal_run_heartbeat_now: RETIRED_FIRST_PARTY_TOOL_NAMES[2],
  marshal_workflow_install: RETIRED_FIRST_PARTY_TOOL_NAMES[3],
  marshal_workflow_install_local: RETIRED_FIRST_PARTY_TOOL_NAMES[4],
};

function buildLegacyToolNameMap(): Record<string, string> {
  const out: Record<string, string> = {};
  const addMarshalName = (legacyName: string, canonicalName: string): void => {
    out[legacyName] = canonicalName;
    out[`m_${legacyName.slice("marshal_".length)}`] = canonicalName;
  };

  for (const canonicalName of PUBLIC_SELF_TOOL_NAMES) {
    const legacyName =
      ownValue(legacySelfNameOverrides, canonicalName) ?? `marshal_${camelToSnake(canonicalName)}`;
    addMarshalName(legacyName, canonicalName);
  }
  for (const [legacyName, canonicalName] of Object.entries(legacyLocalFileNames)) {
    addMarshalName(legacyName, canonicalName);
  }
  for (const [legacyName, canonicalName] of Object.entries(retiredLegacySelfNames)) {
    addMarshalName(legacyName, canonicalName);
  }
  return out;
}

export const LEGACY_FIRST_PARTY_TOOL_NAME_MAP: Readonly<Record<string, string>> =
  buildLegacyToolNameMap();
const legacyFirstPartyToolNameSet = new Set(Object.keys(LEGACY_FIRST_PARTY_TOOL_NAME_MAP));

export function isLegacyFirstPartyToolName(name: string): boolean {
  return legacyFirstPartyToolNameSet.has(name);
}

const LEGACY_PERMISSION_GROUP_NAME_MAP: Readonly<Record<string, string | null>> = {
  marshal_running_tools: "runningTools",
  marshal_memory: "memory",
  marshal_automations: "automations",
  marshal_skills: "skills",
  marshal_settings: "settings",
  marshal_sessions: "sessions",
  marshal_models: "models",
  marshal_heartbeat: null,
  marshal_workflows: "workflows",
  marshal_ui: "uiActions",
  marshal_agent: "agentControl",
  marshal_goals: "goals",
  marshal_local_files: "localFiles",
};

function buildLegacyPermissionGroupMap(): Record<string, string | null> {
  const out: Record<string, string | null> = { ...LEGACY_PERMISSION_GROUP_NAME_MAP };
  for (const [legacyName, canonicalName] of Object.entries(LEGACY_PERMISSION_GROUP_NAME_MAP)) {
    if (legacyName.startsWith("marshal_")) {
      out[`m_${legacyName.slice("marshal_".length)}`] = canonicalName;
    }
  }
  return out;
}

const legacyPermissionGroupMap = buildLegacyPermissionGroupMap();
const legacyPermissionNames = [
  ...Object.keys(LEGACY_FIRST_PARTY_TOOL_NAME_MAP),
  ...Object.keys(legacyPermissionGroupMap),
];

export function canonicalizeFirstPartyToolName(name: string): string {
  return ownValue(LEGACY_FIRST_PARTY_TOOL_NAME_MAP, name) ?? name;
}

export function canonicalizeFirstPartyPermissionKey(key: string): string | null {
  if (!key.startsWith("tool:")) return key;
  const name = key.slice("tool:".length);
  const canonicalGroup = ownValue(legacyPermissionGroupMap, name);
  if (canonicalGroup !== undefined) {
    return canonicalGroup === null ? null : `tool:${canonicalGroup}`;
  }
  const canonicalName = canonicalizeFirstPartyToolName(name);
  if (isRetiredFirstPartyToolName(canonicalName)) return null;
  return canonicalName === name ? key : `tool:${canonicalName}`;
}

export function expandLegacyFirstPartyPermissionPattern(key: string): string[] | null {
  if (!key.startsWith("tool:") || !key.includes("*")) return null;
  const namePattern = key.slice("tool:".length);
  if (!namePattern.startsWith("marshal_") && !namePattern.startsWith("m_")) {
    return null;
  }
  const escaped = namePattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  const matcher = new RegExp(`^${escaped}$`);
  const canonicalKeys = new Set<string>();
  let matchedLegacyName = false;
  for (const legacyName of legacyPermissionNames) {
    if (!matcher.test(legacyName)) continue;
    matchedLegacyName = true;
    const canonical = canonicalizeFirstPartyPermissionKey(`tool:${legacyName}`);
    if (canonical) canonicalKeys.add(canonical);
  }
  return matchedLegacyName ? [...canonicalKeys].sort() : null;
}
