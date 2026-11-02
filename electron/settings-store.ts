import * as fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  DEFAULT_PERMISSIONS,
  DEFAULT_SETTINGS,
  normalizeRuntimeSelectionSettings,
} from "../common/marshal-default-settings";
import type { ExperimentFlags } from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import { DISPLAY_NAME_TO_CONFIG_KEY } from "../common/marshal-permission-servers";
import { DEFAULT_TOOL_APPROVALS } from "../common/marshal-tool-registry";
import {
  DEFAULT_MEMORY_PROVIDER_ID,
  MAX_RELAY_PROGRESS_INTERVAL_MINUTES,
  MIN_RELAY_PROGRESS_INTERVAL_MINUTES,
  DEFAULT_SESSION_STORAGE_PROVIDER_ID,
  DEFAULT_SKILL_PROVIDER_IDS,
  LOCAL_MEMORY_PROVIDER_ID,
  isRelayAccountId,
  isRelayConnectionIntent,
  isRelayProviderId,
  normalizeProviderId,
  normalizeProviderSelectionSettings,
  normalizeRelaySettings,
  normalizeSkillProviderIds,
} from "../common/provider-config";
import { COPILOT_RUNTIME_ID, normalizeRuntimeId } from "../common/runtime-config";
import { getAppDataDir } from "./app-paths";
import type { MSettings, PermissionsConfig } from "./ipc/types";
import { migrateToolPermissionKeys } from "./migrate-tool-permission-keys";
import { migrateToolsFromAllow } from "./migrate-tools-from-allow";
import { secureMkdir, secureWriteFile } from "./platform-security";

const log = createLogger("Settings");

const SETTINGS_PATH = path.join(getAppDataDir(), "marshal-settings.json");

export { DEFAULT_PERMISSIONS, DEFAULT_SETTINGS };

// ── Zod schema for on-disk settings ─────────────────────────────────────────
// Mirrors MSettings from common/marshal-ipc-contract.ts.  `.strip()` drops unknown
// keys at every level, which is the compliance requirement (SF-4).
// When a new field is added to MSettings, add it here too — TypeScript will
// flag the mismatch via the `satisfies` check at the bottom of the schema.

const ServerPermissionsSchema = z
  .object({
    write: z.boolean().optional(),
    shell: z.boolean().optional(),
    mcp: z.boolean().optional(),
    read: z.boolean().optional(),
    url: z.boolean().optional(),
    "custom-tool": z.boolean().optional(),
  })
  .strip();

export const ServerPermissionSchema = z
  .object({ enabled: z.boolean(), autoApprove: z.boolean() })
  .strip();

export const PermissionsConfigSchema = z
  .object({
    autopilotMode: z.boolean().optional(),
    autoApproveReadOnly: z.boolean().default(false),
    allow: z.array(z.string()).default([]),
    denyPatterns: z.array(z.string()).optional(),
    allowedSensitivePaths: z.array(z.string()).optional(),
    allowedReadFolders: z.array(z.string()).optional(),
    allowedWriteFolders: z.array(z.string()).optional(),
    allowModelPermissionsChange: z.boolean().optional(),
    tools: z.record(z.string(), z.boolean()).default({}),
    previousTools: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
    servers: z.record(z.string(), ServerPermissionSchema).default({}),
  })
  .strip();

const ExperimentsSchema = z
  .object({
    promptReplacement: z.boolean().optional(),
    leanPrompt: z.boolean().optional(),
    leanRepoRules: z.boolean().optional(),
    leanCore: z.boolean().optional(),
    titleBarNavigation: z.boolean().optional(),
    cloudSync: z.boolean().optional(),
    uiExtensionsSystem: z.boolean().optional(),
  })
  .strip();

const RelayProviderIdSchema = z.string().refine(isRelayProviderId);
const RelayAccountIdSchema = z.string().refine(isRelayAccountId);
const RelayConnectionIntentSchema = z.string().refine(isRelayConnectionIntent);

const RelayProviderConfigSchema = z
  .object({
    enabled: z.boolean(),
    accountId: RelayAccountIdSchema.optional(),
    connectionIntent: RelayConnectionIntentSchema,
  })
  .strip();

const RelaySettingsSchema = z
  .object({
    providers: z.record(RelayProviderIdSchema, RelayProviderConfigSchema),
    defaultNotificationDestinations: z.array(RelayProviderIdSchema),
    progressDestinations: z.array(RelayProviderIdSchema),
    progressIntervalMinutes: z
      .number()
      .int()
      .min(MIN_RELAY_PROGRESS_INTERVAL_MINUTES)
      .max(MAX_RELAY_PROGRESS_INTERVAL_MINUTES),
  })
  .strip();

const WhatsAppSettingsSchema = z
  .object({
    enabled: z.boolean(),
    defaultNotificationsEnabled: z.boolean(),
    progressNotificationsEnabled: z.boolean(),
  })
  .strip();

// Values stay plain strings on disk so one unknown runtime id cannot fail the
// whole settings parse; consumers apply normalizeModelRuntimeRouting().
const ModelRuntimeRoutingSchema = z
  .object({
    anthropic: z.string().optional(),
    openai: z.string().optional(),
    google: z.string().optional(),
  })
  .strip();

// Loose on disk like ModelRuntimeRoutingSchema; consumers apply normalizeRuntimeAccounts().
const RuntimeAccountsConfigSchema = z
  .object({
    accounts: z
      .array(z.object({ id: z.string(), label: z.string().optional() }).strip())
      .optional(),
    defaultAccountId: z.string().optional(),
  })
  .strip();
const RuntimeAccountsSchema = z
  .object({
    claude: RuntimeAccountsConfigSchema.optional(),
    codex: RuntimeAccountsConfigSchema.optional(),
    cursor: RuntimeAccountsConfigSchema.optional(),
  })
  .strip();

// Compile-time guard: fail if ExperimentFlags has keys not in the Zod schema.
// Prevents silent data loss from .strip() dropping unknown fields.
type _ExperimentsGuard =
  Exclude<keyof ExperimentFlags, keyof z.infer<typeof ExperimentsSchema>> extends never
    ? true
    : { ERROR: "ExperimentsSchema is missing key(s) from ExperimentFlags" };
const _experimentsGuardCheck: _ExperimentsGuard = true;
void _experimentsGuardCheck;

export const MSettingsSchema = z
  .object({
    autoApprove: z
      .object({
        global: z.boolean().optional(),
        perServer: z.record(z.string(), ServerPermissionsSchema).optional(),
      })
      .strip()
      .optional(),
    permissions: PermissionsConfigSchema.optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
    relay: RelaySettingsSchema.optional(),
    whatsapp: WhatsAppSettingsSchema.optional(),
    interceptFileChooser: z.boolean().optional(),
    experiments: ExperimentsSchema.optional(),
    runtimeId: z.string().optional(),
    memoryProviderId: z.string().optional(),
    sessionStorageProviderId: z.string().optional(),
    skillProviderIds: z.array(z.string()).optional(),
    notificationProviderId: z.string().optional(),
    miniModeEnabled: z.boolean().optional(),
    startInMiniModeEnabled: z.boolean().optional(),
    showHideShortcutEnabled: z.boolean().optional(),
    showHideShortcut: z.string().optional(),
    sessionRetentionDays: z.number().optional(),
    telemetryEnabled: z.boolean().optional(),
    preventSleepEnabled: z.boolean().optional(),
    mouseWiggleEnabled: z.boolean().optional(),
    alwaysKeepAwakeEnabled: z.boolean().optional(),
    workspaceDir: z.string().optional(),
    worktreeDir: z.string().optional(),
    swarmRoleModels: z
      .object({
        planner: z
          .object({
            model: z.string().trim().min(1),
            reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
          })
          .strict()
          .optional(),
        reviewer: z
          .object({
            model: z.string().trim().min(1),
            reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
          })
          .strict()
          .optional(),
        worker: z
          .object({
            model: z.string().trim().min(1),
            reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
          })
          .strict()
          .optional(),
        reconciler: z
          .object({
            model: z.string().trim().min(1),
            reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    swarmWorkerModel: z.string().min(1).optional(),
    swarmWorkerReasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    modelRuntimeRouting: ModelRuntimeRoutingSchema.optional(),
    runtimeAccounts: RuntimeAccountsSchema.optional(),
    updateChannelBeta: z.boolean().optional(),
    issueReporter: z
      .object({ providerId: z.string().optional(), target: z.string().optional() })
      .strip()
      .optional(),
  })
  .strip();

// Compile-time completeness guard: if MSettings gains a key not in the schema,
// Exclude<> resolves to a non-never union of the missing key(s) and this
// conditional type evaluates to a string-literal error, making the intersection
// with the schema's output type produce a type error at the first call site
// that expects Partial<MSettings>.
/* eslint-disable @typescript-eslint/no-redundant-type-constituents -- intentional: the `& unknown` arm is only benign when the schema is complete; if a key is missing, it becomes `& "ERROR: ..."` and the cast below fails */
type SettingsSchemaOutput = z.infer<typeof MSettingsSchema> &
  (Exclude<keyof MSettings, keyof z.infer<typeof MSettingsSchema>> extends never
    ? unknown
    : `ERROR: MSettingsSchema is missing key(s)`);
/* eslint-enable @typescript-eslint/no-redundant-type-constituents */

/** Parse raw JSON through the Zod schema — unknown keys are stripped at every level. */
function parseSettingsFromDisk(data: unknown): Partial<MSettings> {
  const result = MSettingsSchema.safeParse(data);
  if (!result.success) {
    log.warn("Schema validation issues — using defaults:", result.error.format());
    return {};
  }
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-unnecessary-type-assertion -- Zod safeParse output → Partial<MSettings>; double cast is part of compile-time completeness guard above
  const parsed = result.data as SettingsSchemaOutput as Partial<MSettings>;
  return normalizeProviderSelectionSettings(normalizeRuntimeSelectionSettings(parsed));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function migrateRuntimeSettings(data: unknown): { data: unknown; changed: boolean } {
  if (!isRecord(data)) return { data, changed: false };
  const runtimeId =
    typeof data.runtimeId === "string" && data.runtimeId.trim()
      ? normalizeRuntimeId(data.runtimeId)
      : COPILOT_RUNTIME_ID;
  const { cloudProviderId: _cloudProviderId, ...remaining } = data;
  const changed = data.runtimeId !== runtimeId || "cloudProviderId" in data;
  if (!changed) return { data, changed: false };
  return {
    data: {
      ...remaining,
      runtimeId,
    },
    changed: true,
  };
}

export function migrateRelaySettings(data: unknown): { data: unknown; changed: boolean } {
  if (!isRecord(data)) return { data, changed: false };
  const whatsapp = isRecord(data.whatsapp) ? data.whatsapp : undefined;

  const relay = normalizeRelaySettings(data.relay, {
    whatsappEnabled: whatsapp?.enabled,
    whatsappDefaultNotificationsEnabled: whatsapp?.defaultNotificationsEnabled,
    whatsappProgressNotificationsEnabled: whatsapp?.progressNotificationsEnabled,
  });
  const {
    teamsNotify: _teamsNotify,
    teamsRelayConnected: _teamsRelayConnected,
    teamsAgentNotificationsEnabled: _teamsAgentNotificationsEnabled,
    teamsProgressNotificationsEnabled: _teamsProgressNotificationsEnabled,
    teamsProgressNotificationIntervalSeconds: _teamsProgressNotificationIntervalSeconds,
    ...remaining
  } = data;
  const changed =
    "teamsNotify" in data ||
    "teamsRelayConnected" in data ||
    "teamsAgentNotificationsEnabled" in data ||
    "teamsProgressNotificationsEnabled" in data ||
    "teamsProgressNotificationIntervalSeconds" in data ||
    JSON.stringify(data.relay) !== JSON.stringify(relay);

  if (!changed) return { data, changed: false };
  return {
    data: { ...remaining, relay },
    changed: true,
  };
}

function migrateProviderSettings(data: unknown): { data: unknown; changed: boolean } {
  if (!isRecord(data)) return { data, changed: false };
  const experiments = isRecord(data.experiments) ? data.experiments : {};
  const requestedMemoryProviderId =
    typeof data.memoryProviderId === "string" && data.memoryProviderId.trim()
      ? normalizeProviderId(data.memoryProviderId, DEFAULT_MEMORY_PROVIDER_ID)
      : DEFAULT_MEMORY_PROVIDER_ID;
  const memoryProviderId =
    requestedMemoryProviderId === "memora" || requestedMemoryProviderId === "memora-shadow"
      ? LOCAL_MEMORY_PROVIDER_ID
      : requestedMemoryProviderId === "onedrive"
        ? DEFAULT_MEMORY_PROVIDER_ID
        : requestedMemoryProviderId;
  const sessionStorageProviderId =
    typeof data.sessionStorageProviderId === "string" && data.sessionStorageProviderId.trim()
      ? normalizeProviderId(data.sessionStorageProviderId, DEFAULT_SESSION_STORAGE_PROVIDER_ID)
      : DEFAULT_SESSION_STORAGE_PROVIDER_ID;
  const skillProviderIds = Array.isArray(data.skillProviderIds)
    ? normalizeSkillProviderIds(
        data.skillProviderIds.filter((id): id is string => typeof id === "string"),
      )
    : [...DEFAULT_SKILL_PROVIDER_IDS];
  const providerSettings = normalizeProviderSelectionSettings({
    memoryProviderId,
    sessionStorageProviderId,
    skillProviderIds,
    notificationProviderId:
      typeof data.notificationProviderId === "string" ? data.notificationProviderId : undefined,
  });
  const { memoraEnabled: _memoraEnabled, ...remainingExperiments } = experiments;
  const existingSkillProviderIds = Array.isArray(data.skillProviderIds)
    ? data.skillProviderIds.filter((id): id is string => typeof id === "string")
    : [];
  const changed =
    data.memoryProviderId !== providerSettings.memoryProviderId ||
    data.sessionStorageProviderId !== providerSettings.sessionStorageProviderId ||
    existingSkillProviderIds.length !== providerSettings.skillProviderIds.length ||
    existingSkillProviderIds.some((id, index) => id !== providerSettings.skillProviderIds[index]) ||
    data.notificationProviderId !== providerSettings.notificationProviderId ||
    "memoraEnabled" in experiments;
  if (!changed) return { data, changed: false };
  return {
    data: {
      ...data,
      ...providerSettings,
      experiments: remainingExperiments,
    },
    changed: true,
  };
}

// Strict string[] filter: drops non-strings, empty/whitespace, and bare "*"
// (which would match everything — security footgun in allow OR deny lists).
function parseStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return (input as unknown[]).filter(
    (item): item is string =>
      typeof item === "string" &&
      item.trim().length > 0 &&
      !/^(\*\*\/\*|\*{1,2})$/.test(item.trim()),
  );
}

// Used by both disk-load AND updateSettings, so silently-dropped fields
// affect persistence and agent writes. New PermissionsConfig fields MUST
// be added to the return below — same bug class that hid `denyPatterns`.
export function sanitizePermissions(input: unknown): PermissionsConfig {
  if (!isRecord(input)) return { ...DEFAULT_PERMISSIONS };

  const autoApproveReadOnly =
    typeof input.autoApproveReadOnly === "boolean" ? input.autoApproveReadOnly : false;
  const autopilotMode = typeof input.autopilotMode === "boolean" ? input.autopilotMode : false;

  const allowModelPermissionsChange =
    typeof input.allowModelPermissionsChange === "boolean"
      ? input.allowModelPermissionsChange
      : false;

  const allow = parseStringArray(input.allow);

  // Permission kind names that are NOT also legitimate server names must not be
  // used as server keys — they collide with the evaluate() fallback
  // `serverName = getServerName(request) || request.kind`.
  // Note: "shell" is excluded because it IS a real server (SDK capability).
  const RESERVED_SERVER_KEYS = new Set(["write", "url", "read", "custom-tool", "mcp"]);

  const servers: Record<string, { enabled: boolean; autoApprove: boolean }> = {};
  if (isRecord(input.servers)) {
    for (const [key, value] of Object.entries(input.servers)) {
      if (RESERVED_SERVER_KEYS.has(key)) {
        log.warn(`Stripping reserved server key "${key}" from permissions.servers`);
        continue;
      }
      if (
        isRecord(value) &&
        typeof value.enabled === "boolean" &&
        typeof value.autoApprove === "boolean"
      ) {
        servers[key] = { enabled: value.enabled, autoApprove: value.autoApprove };
      }
    }
  }

  const tools: Record<string, boolean> = {};
  if (isRecord(input.tools)) {
    for (const [key, value] of Object.entries(input.tools)) {
      if (typeof value === "boolean") {
        tools[key] = value;
      }
    }
  }

  // Drop dead per-tool keys for the removed filesystem MCP server (file reads
  // are now gated by `tool:read` + the filesystem capability + folder grants).
  // `servers.filesystem.{enabled,autoApprove}` and `tool:read` are untouched.
  for (const key of Object.keys(tools)) {
    if (key === "mcp:filesystem" || key.startsWith("mcp:filesystem:")) {
      delete tools[key];
    }
  }

  // previousTools survives group-toggle restore — don't prune against
  // current tools map; snapshot keys can be absent from tools.
  const previousTools: Record<string, Record<string, boolean>> = {};
  if (isRecord(input.previousTools)) {
    for (const [groupKey, snapshot] of Object.entries(input.previousTools)) {
      // Drop the removed filesystem MCP group's restore snapshot (parallel to
      // the dead-key prune on `tools` above) so it doesn't survive forever.
      if (groupKey === "mcp:filesystem" || groupKey.startsWith("mcp:filesystem:")) continue;
      if (isRecord(snapshot)) {
        const validSnapshot: Record<string, boolean> = {};
        for (const [toolKey, value] of Object.entries(snapshot)) {
          if (typeof value === "boolean") {
            validSnapshot[toolKey] = value;
          }
        }
        if (Object.keys(validSnapshot).length > 0) {
          previousTools[groupKey] = validSnapshot;
        }
      }
    }
  }

  const denyPatterns = parseStringArray(input.denyPatterns);
  const allowedSensitivePaths = parseStringArray(input.allowedSensitivePaths);

  const allowedReadFolders = parseStringArray(input.allowedReadFolders);
  const allowedWriteFolders = parseStringArray(input.allowedWriteFolders);

  const migrated = migrateToolPermissionKeys({
    autopilotMode,
    autoApproveReadOnly,
    allow,
    allowModelPermissionsChange,
    allowedSensitivePaths,
    tools,
    servers,
    previousTools,
    denyPatterns,
    ...(allowedReadFolders.length ? { allowedReadFolders } : {}),
    ...(allowedWriteFolders.length ? { allowedWriteFolders } : {}),
  }).perms;

  const toolsWithDefaults = { ...migrated.tools };
  // Backfill defaults only after legacy keys are canonicalized so an explicit
  // persisted deny wins over a default allow for the same tool.
  for (const [key, value] of Object.entries(DEFAULT_TOOL_APPROVALS)) {
    if (!(key in toolsWithDefaults)) toolsWithDefaults[key] = value;
  }

  return { ...migrated, tools: toolsWithDefaults };
}

/**
 * Migrate tool: and mcp: patterns from allow to tools map.
 * Shell patterns (no prefix) stay in allow.
 */
export { migrateToolsFromAllow };

/**
 * Migrate old autoApprove to new permissions block.
 * Returns null if permissions already exists (no migration needed).
 *
 * Note: the parallel `disabledServers` migration branch was removed.
 * PR B (shipped 2026-04-29) writes a `permissions` block on first run
 * for any install opened after that date, so any install reaching this
 * function on a post-removal build without a `permissions` key would have to
 * have been opened only before 2026-04-29. In that rare case the on-disk
 * `disabledServers` value is silently dropped and the affected server (e.g.
 * Work Services) reverts to enabled — no audit entry. Acceptable trade-off given
 * the cutoff window.
 */
export function migratePermissions(settings: Record<string, unknown>): PermissionsConfig | null {
  if (settings.permissions) return null;

  const result: PermissionsConfig = {
    autopilotMode: false,
    autoApproveReadOnly: false,
    allow: [],
    tools: {},
    servers: { ...DEFAULT_PERMISSIONS.servers },
  };

  const oldAutoApprove = isRecord(settings.autoApprove) ? settings.autoApprove : undefined;

  // Migrate global auto-approve → all servers autoApprove
  if (oldAutoApprove && oldAutoApprove.global === true) {
    for (const key of Object.keys(result.servers)) {
      result.servers[key] = { ...result.servers[key], autoApprove: true };
    }
  }

  // Migrate per-server (display name → config key)
  const perServer = isRecord(oldAutoApprove?.perServer) ? oldAutoApprove.perServer : undefined;
  if (perServer) {
    for (const [displayName, perms] of Object.entries(perServer)) {
      const configKey = DISPLAY_NAME_TO_CONFIG_KEY[displayName];
      if (configKey && result.servers[configKey] && isRecord(perms)) {
        const hasAnyTrue = Object.values(perms).some((v) => v === true);
        if (hasAnyTrue) {
          result.servers[configKey] = { ...result.servers[configKey], autoApprove: true };
        }
      }
    }
  }

  return result;
}

export function loadSettingsFromDisk(): MSettings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")); // SF-4: validated — immediately passed through MSettingsSchema.safeParse() in parseSettingsFromDisk()
      const runtimeMigration = migrateRuntimeSettings(raw);
      const providerMigration = migrateProviderSettings(runtimeMigration.data);
      const relayMigration = migrateRelaySettings(providerMigration.data);
      const known = parseSettingsFromDisk(relayMigration.data);
      const settings: MSettings = {
        ...DEFAULT_SETTINGS,
        ...known,
        autoApprove: { ...DEFAULT_SETTINGS.autoApprove, ...known.autoApprove },
        experiments: { ...DEFAULT_SETTINGS.experiments, ...known.experiments },
      };
      // Migrate old permission settings to new unified block
      const migrated = migratePermissions(isRecord(raw) ? raw : {});
      if (migrated) {
        settings.permissions = migrated;
      }

      // Canonicalize before default backfill so legacy explicit values win.
      const preSanitizeToolMigration = migrateToolPermissionKeys(
        settings.permissions ?? DEFAULT_PERMISSIONS,
      );
      settings.permissions = sanitizePermissions(preSanitizeToolMigration.perms);

      // Migration: autoApproveAll was removed from the Zod schema (stripped on parse).
      // Check the raw disk data and upgrade to autoApproveReadOnly as a safe default.
      const rawPerms = isRecord(raw) ? raw.permissions : undefined;
      if (isRecord(rawPerms) && rawPerms.autoApproveAll === true) {
        log.warn(
          "autoApproveAll has been removed — migrating to autoApproveReadOnly. Enable individual server auto-approve toggles for broader approval.",
        );
        settings.permissions = { ...settings.permissions, autoApproveReadOnly: true };
      }

      // Migrate tool:/mcp: patterns from allow to tools map
      const beforeMigration = settings.permissions.allow.length;
      settings.permissions = migrateToolsFromAllow(settings.permissions);
      if (settings.permissions.allow.length !== beforeMigration) {
        // Migration moved entries — persist so they don't re-migrate on every load
        saveSettingsToDisk(settings);
      }

      const toolKeyMigration = migrateToolPermissionKeys(settings.permissions);
      if (toolKeyMigration.changed) {
        settings.permissions = toolKeyMigration.perms;
      }
      if (preSanitizeToolMigration.changed || toolKeyMigration.changed) {
        saveSettingsToDisk(settings);
      }

      if (runtimeMigration.changed || providerMigration.changed || relayMigration.changed) {
        saveSettingsToDisk(settings);
      }

      return settings;
    }
  } catch (err) {
    log.error("Failed to load settings:", err);
  }
  return { ...DEFAULT_SETTINGS };
}

// Serializes concurrent writes so they don't interleave and corrupt the file.
let pendingWrite: Promise<void> = Promise.resolve();

export function saveSettingsToDisk(settings: MSettings): void {
  let json: string;
  try {
    const normalized = normalizeProviderSelectionSettings(settings);
    const parsed = MSettingsSchema.safeParse(normalized);
    if (!parsed.success) {
      log.error("Refusing to persist invalid settings:", parsed.error.format());
      return;
    }
    json = JSON.stringify(parsed.data, null, 2);
  } catch (err) {
    log.error("Failed to serialize settings:", err);
    return;
  }
  // Chain off the previous write to avoid interleaved non-atomic writeFile calls
  const dir = path.dirname(SETTINGS_PATH);
  pendingWrite = pendingWrite
    .then(() => secureMkdir(dir, 0o700))
    .then(() => secureWriteFile(SETTINGS_PATH, json, { mode: 0o600 }))
    .catch((err) => log.error("Failed to save settings:", err));
}

/** Resolves when any in-flight settings write completes. Call from before-quit. */
export function flushSettingsWrite(): Promise<void> {
  return pendingWrite;
}
