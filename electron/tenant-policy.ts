import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PermissionKind } from "../common/marshal-ipc-contract";
import { createLogger } from "../common/marshal-logger";
import { ALL_PERMISSION_KINDS } from "./permission-policy";

const log = createLogger("TenantPolicy");

export interface TenantPolicy {
  version?: number;
  /** MCP server config keys to block (e.g. "playwright", "filesystem"). */
  disabledServers?: string[];
  /** Permission kinds to unconditionally deny (e.g. "shell", "mcp"). */
  disabledPermissionKinds?: PermissionKind[];
  /** When true, every non-read tool call requires explicit user approval. */
  forcePrompt?: boolean;
  /** Model IDs to block. Models with these IDs won't appear in the picker. */
  disabledModels?: string[];
  /** When true, heartbeat feature is completely disabled. */
  disableHeartbeat?: boolean;
  /** When true, automation creation and scheduling is disabled. */
  disableAutomations?: boolean;
  /** Inference provider names to block (e.g. "anthropic", "openai"). Blocks all models from these providers. */
  disabledProviders?: string[];
  /** When true, filesystem/shell access is restricted to the workspace directory only. */
  restrictToWorkspace?: boolean;
  /** Origins to block outbound in the Playwright browser context (e.g. "https://evil.com"). */
  browserEgressBlockedOrigins?: string[];
}

const EMPTY_POLICY: TenantPolicy = {};

const VALID_PERMISSION_KINDS = new Set<string>(ALL_PERMISSION_KINDS.filter((k) => k !== "read"));

// Marshal identity: deployed Windows Group Policy writes this registry path and value name.
const REGISTRY_KEY = "HKLM\\SOFTWARE\\Policies\\Marshal";
const REGISTRY_VALUE = "TenantPolicy";
// Marshal identity: deployed Jamf/Intune profiles own this managed-preference domain.
const MANAGED_PREFS_DOMAIN = "com.marshal";
// No Linux enterprise tenants were provisioned before the Marshal name.
const LINUX_SYSTEM_POLICY_DIR = "/etc/marshal";
const LINUX_SYSTEM_POLICY_FILE = "policy.json";
/** How often to re-read policy from source (ms). */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** Validate and sanitize a raw parsed object into a TenantPolicy. */
function sanitize(raw: Record<string, unknown>): TenantPolicy {
  const policy: TenantPolicy = {};

  if (typeof raw.version === "number") policy.version = raw.version;

  if (Array.isArray(raw.disabledServers)) {
    policy.disabledServers = raw.disabledServers.filter((s: unknown) => typeof s === "string");
  }

  if (Array.isArray(raw.disabledPermissionKinds)) {
    policy.disabledPermissionKinds = raw.disabledPermissionKinds.filter(
      (k: unknown): k is PermissionKind => typeof k === "string" && VALID_PERMISSION_KINDS.has(k),
    );
  }

  if (typeof raw.forcePrompt === "boolean") policy.forcePrompt = raw.forcePrompt;

  if (Array.isArray(raw.disabledModels)) {
    policy.disabledModels = raw.disabledModels.filter((m: unknown) => typeof m === "string");
  }
  if (typeof raw.disableHeartbeat === "boolean") policy.disableHeartbeat = raw.disableHeartbeat;
  if (typeof raw.disableWorkflows === "boolean") policy.disableAutomations = raw.disableWorkflows;
  if (typeof raw.disableAutomations === "boolean")
    policy.disableAutomations = raw.disableAutomations;

  if (Array.isArray(raw.disabledProviders)) {
    policy.disabledProviders = raw.disabledProviders.filter((p: unknown) => typeof p === "string");
  }
  if (typeof raw.restrictToWorkspace === "boolean")
    policy.restrictToWorkspace = raw.restrictToWorkspace;

  if (Array.isArray(raw.browserEgressBlockedOrigins)) {
    policy.browserEgressBlockedOrigins = raw.browserEgressBlockedOrigins.filter(isValidOrigin);
  }

  return policy;
}

/** Parse a JSON string into a sanitized TenantPolicy, or return null on failure. */
function parseAndSanitize(json: string): TenantPolicy | null {
  try {
    const raw: unknown = JSON.parse(json); // SF-4: validated — type-checked and sanitize() applies whitelist checks below
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by object/null/array guards above
    return sanitize(raw as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Parse a comma-separated string into a non-empty string array, or undefined. */
function parseCommaSeparated(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** Accepts only well-formed http/https origins with no path, query, or fragment. */
function isValidOrigin(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === s;
  } catch {
    return false;
  }
}

/** Read a single REG_SZ value from the Marshal policy key. Returns undefined if absent. */
function readRegistryValue(name: string): string | undefined {
  try {
    const output = execFileSync("reg", ["query", REGISTRY_KEY, "/v", name], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = /REG_(?:SZ|DWORD)\s+(.+)/i.exec(output);
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read tenant policy from Windows registry (HKLM\SOFTWARE\Policies\Marshal).
 * Prefers **individual registry values** (Intune-compatible, per-setting conflict resolution).
 * Falls back to the legacy JSON blob (`TenantPolicy` REG_SZ) for backward compatibility.
 *
 * Individual values: DisabledServers (comma-separated), ForcePrompt (0/1 DWORD),
 * DisabledModels (comma-separated), DisableHeartbeat (0/1), DisableWorkflows (0/1),
 * DisabledPermissions (comma-separated), DisabledProviders (comma-separated),
 * RestrictToWorkspace (0/1), BrowserEgressBlockedOrigins (comma-separated),
 * PolicyVersion (DWORD).
 */
export function readRegistryPolicy(platform: string): TenantPolicy | null {
  if (platform !== "win32") return null;

  // Try individual registry values first (Intune-friendly)
  const policy: TenantPolicy = {};
  let hasIndividualValues = false;

  const versionStr = readRegistryValue("PolicyVersion");
  if (versionStr !== undefined) {
    const v = Number(versionStr);
    if (!isNaN(v) && v > 0) {
      policy.version = v;
      hasIndividualValues = true;
    }
  }

  const servers = readRegistryValue("DisabledServers");
  if (servers !== undefined) {
    policy.disabledServers = parseCommaSeparated(servers);
    hasIndividualValues = true;
  }

  const perms = readRegistryValue("DisabledPermissions");
  if (perms !== undefined) {
    const raw = parseCommaSeparated(perms);
    if (raw) {
      policy.disabledPermissionKinds = raw.filter((k): k is PermissionKind =>
        VALID_PERMISSION_KINDS.has(k),
      );
    }
    hasIndividualValues = true;
  }

  const forcePrompt = readRegistryValue("ForcePrompt");
  if (forcePrompt !== undefined) {
    policy.forcePrompt = forcePrompt === "1" || forcePrompt.toLowerCase() === "0x1";
    hasIndividualValues = true;
  }

  const models = readRegistryValue("DisabledModels");
  if (models !== undefined) {
    policy.disabledModels = parseCommaSeparated(models);
    hasIndividualValues = true;
  }

  const heartbeat = readRegistryValue("DisableHeartbeat");
  if (heartbeat !== undefined) {
    policy.disableHeartbeat = heartbeat === "1" || heartbeat.toLowerCase() === "0x1";
    hasIndividualValues = true;
  }

  const workflows = readRegistryValue("DisableWorkflows");
  if (workflows !== undefined) {
    policy.disableAutomations = workflows === "1" || workflows.toLowerCase() === "0x1";
    hasIndividualValues = true;
  }

  const providers = readRegistryValue("DisabledProviders");
  if (providers !== undefined) {
    policy.disabledProviders = parseCommaSeparated(providers);
    hasIndividualValues = true;
  }

  const sandbox = readRegistryValue("RestrictToWorkspace");
  if (sandbox !== undefined) {
    policy.restrictToWorkspace = sandbox === "1" || sandbox.toLowerCase() === "0x1";
    hasIndividualValues = true;
  }

  const egressBlocklist = readRegistryValue("BrowserEgressBlockedOrigins");
  if (egressBlocklist !== undefined) {
    policy.browserEgressBlockedOrigins =
      parseCommaSeparated(egressBlocklist)?.filter(isValidOrigin);
    hasIndividualValues = true;
  }

  if (hasIndividualValues) return policy;

  // Legacy fallback: single JSON blob
  try {
    const output = execFileSync("reg", ["query", REGISTRY_KEY, "/v", REGISTRY_VALUE], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Output format: "    TenantPolicy    REG_SZ    {json}\r\n"
    const match = /REG_SZ\s+(.+)/i.exec(output);
    if (!match) return null;
    return parseAndSanitize(match[1].trim());
  } catch {
    return null;
  }
}

/**
 * Read a single managed preference key from MDM-managed plist files only.
 * Reads the per-user managed pref path first, then the device-wide path.
 * Does NOT use `defaults read <domain>` — that walks the CFPreferences search
 * list and falls through to user-writable ~/Library/Preferences, which would
 * let any user bypass policy via `defaults write`.
 */
function readManagedPref(key: string): string | undefined {
  const userName = os.userInfo().username;
  const managedPrefPaths = [
    `/Library/Managed Preferences/${userName}/${MANAGED_PREFS_DOMAIN}`,
    `/Library/Managed Preferences/${MANAGED_PREFS_DOMAIN}`,
  ];
  for (const plistPath of managedPrefPaths) {
    if (!fs.existsSync(`${plistPath}.plist`)) continue;
    try {
      const output = execFileSync("defaults", ["read", plistPath, key], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output.trim();
    } catch {
      // key absent in this plist — try next path
    }
  }
  return undefined;
}

/** Parse a macOS defaults boolean/int (0/1 string). */
function parsePrefBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "1";
}

/**
 * Read tenant policy from macOS managed preferences (MDM profiles).
 * Prefers **individual preference keys** (MDM-profile-compatible, per-setting payloads).
 * Falls back to the legacy JSON blob (`TenantPolicy` key) for backward compatibility.
 *
 * Individual keys: DisabledServers (comma-separated), ForcePrompt (0/1),
 * DisabledModels (comma-separated), DisableHeartbeat (0/1), DisableWorkflows (0/1),
 * DisabledPermissions (comma-separated), DisabledProviders (comma-separated),
 * RestrictToWorkspace (0/1), BrowserEgressBlockedOrigins (comma-separated),
 * PolicyVersion (integer).
 */
export function readManagedPrefsPolicy(platform: string): TenantPolicy | null {
  if (platform !== "darwin") return null;

  // Try individual preference keys first (MDM-profile-friendly)
  const policy: TenantPolicy = {};
  let hasIndividualKeys = false;

  const versionStr = readManagedPref("PolicyVersion");
  if (versionStr !== undefined) {
    const v = parseInt(versionStr, 10);
    if (!isNaN(v)) {
      policy.version = v;
      hasIndividualKeys = true;
    }
  }

  const servers = readManagedPref("DisabledServers");
  if (servers !== undefined) {
    policy.disabledServers = parseCommaSeparated(servers);
    hasIndividualKeys = true;
  }

  const perms = readManagedPref("DisabledPermissions");
  if (perms !== undefined) {
    const raw = parseCommaSeparated(perms);
    if (raw) {
      policy.disabledPermissionKinds = raw.filter((k): k is PermissionKind =>
        VALID_PERMISSION_KINDS.has(k),
      );
    }
    hasIndividualKeys = true;
  }

  const forcePrompt = parsePrefBool(readManagedPref("ForcePrompt"));
  if (forcePrompt !== undefined) {
    policy.forcePrompt = forcePrompt;
    hasIndividualKeys = true;
  }

  const models = readManagedPref("DisabledModels");
  if (models !== undefined) {
    policy.disabledModels = parseCommaSeparated(models);
    hasIndividualKeys = true;
  }

  const heartbeat = parsePrefBool(readManagedPref("DisableHeartbeat"));
  if (heartbeat !== undefined) {
    policy.disableHeartbeat = heartbeat;
    hasIndividualKeys = true;
  }

  const workflows = parsePrefBool(readManagedPref("DisableWorkflows"));
  if (workflows !== undefined) {
    policy.disableAutomations = workflows;
    hasIndividualKeys = true;
  }

  const providers = readManagedPref("DisabledProviders");
  if (providers !== undefined) {
    policy.disabledProviders = parseCommaSeparated(providers);
    hasIndividualKeys = true;
  }

  const sandbox = parsePrefBool(readManagedPref("RestrictToWorkspace"));
  if (sandbox !== undefined) {
    policy.restrictToWorkspace = sandbox;
    hasIndividualKeys = true;
  }

  const egressBlocklist = readManagedPref("BrowserEgressBlockedOrigins");
  if (egressBlocklist !== undefined) {
    policy.browserEgressBlockedOrigins =
      parseCommaSeparated(egressBlocklist)?.filter(isValidOrigin);
    hasIndividualKeys = true;
  }

  if (hasIndividualKeys) return policy;

  // Legacy fallback: single JSON blob — same filesystem-direct approach to
  // avoid CFPreferences user-pref fallthrough.
  const userName = os.userInfo().username;
  const legacyPaths = [
    `/Library/Managed Preferences/${userName}/${MANAGED_PREFS_DOMAIN}`,
    `/Library/Managed Preferences/${MANAGED_PREFS_DOMAIN}`,
  ];
  for (const plistPath of legacyPaths) {
    if (!fs.existsSync(`${plistPath}.plist`)) continue;
    try {
      const output = execFileSync("defaults", ["read", plistPath, REGISTRY_VALUE], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return parseAndSanitize(output.trim());
    } catch {
      // key absent — try next path
    }
  }
  return null;
}

/**
 * Read tenant policy from Linux system policy file (/etc/marshal/policy.json).
 * Returns null on non-Linux platforms or when the file doesn't exist.
 * This path should ONLY be writable by root/admin, giving it managed-source trust.
 */
export function readLinuxSystemPolicy(platform: string): TenantPolicy | null {
  if (platform !== "linux") return null;
  try {
    const filePath = path.join(LINUX_SYSTEM_POLICY_DIR, LINUX_SYSTEM_POLICY_FILE);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return parseAndSanitize(raw);
  } catch {
    return null;
  }
}

/**
 * Check if a tool should be blocked by tenant policy.
 * Returns the disabled server name if matched, or null if allowed.
 * Used in onPreToolUse for early blocking alongside user-disabled servers.
 *
 * `disabledServers` entries are MCP config keys (e.g. "filesystem", "playwright",
 * "playwright"), NOT UI display names ("File System Access"). Config keys are the
 * stable contract for admin-facing policy — they map directly to the keys in
 * SessionManager.getMcpConfig() and appear as prefixes in SDK tool names
 * (e.g. "filesystem__read_file", "playwright__browser_navigate").
 */
export function isToolDisabledByTenant(
  policy: TenantPolicy | null,
  toolName: string,
): string | null {
  if (!policy?.disabledServers?.length) return null;
  const tl = toolName.toLowerCase();
  for (const serverName of policy.disabledServers) {
    const key = serverName.toLowerCase();
    if (tl.includes(key)) return serverName;
  }
  return null;
}

function isEmpty(policy: TenantPolicy): boolean {
  return Object.keys(policy).length === 0;
}

/**
 * Reads tenant admin policy from a single authoritative source:
 *   - Windows registry / macOS managed preferences (admin-privileged, trusted)
 *   - Disk file ({appDataDir}/tenant-policy.json) — only when no managed source exists
 *
 * When a managed source exists, the disk file is ignored entirely. This prevents
 * the user-writable file from injecting fields the admin never set (different
 * trust levels — registry/MDM require admin, file is user-writable).
 *
 * The disk file remains useful for Linux (no registry/MDM), dev testing, and
 * script-based deployment (SCCM pushing a file).
 *
 * IT admins deploy via GPO / Intune / SCCM (Windows) or MDM profiles (macOS).
 */
export class TenantPolicyProvider extends EventEmitter {
  private policy: TenantPolicy = EMPTY_POLICY;
  private managed = false;
  private policyPath: string;
  private platform: string;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(appDataDir: string, platform: string = process.platform) {
    super();
    this.policyPath = path.join(appDataDir, "tenant-policy.json");
    this.platform = platform;
    this.loadPolicy();
  }

  /** Return the cached policy. */
  get(): TenantPolicy {
    return this.policy;
  }

  /** True if any source provided a non-empty tenant policy. */
  isTenantManaged(): boolean {
    return this.managed;
  }

  /** The resolved file path (useful for diagnostics). */
  getPath(): string {
    return this.policyPath;
  }

  /**
   * Start periodic background refresh of policy from source.
   * Emits 'policyChanged' when the policy materially changes.
   */
  startRefreshTimer(): void {
    if (this.refreshTimer) return; // already running
    this.refreshTimer = setInterval(() => {
      this.refresh();
    }, REFRESH_INTERVAL_MS);
    // Don't keep the process alive just for policy refresh
    if (
      this.refreshTimer &&
      typeof this.refreshTimer === "object" &&
      "unref" in this.refreshTimer
    ) {
      this.refreshTimer.unref();
    }
  }

  /** Stop the periodic refresh timer. */
  stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Re-read policy from source. Emits 'policyChanged' if it changed. */
  refresh(): void {
    const oldJson = JSON.stringify(this.policy);
    this.loadPolicy();
    const newJson = JSON.stringify(this.policy);
    if (oldJson !== newJson) {
      this.emit("policyChanged", this.policy);
    }
  }

  /** Read and parse policy from all sources. Called from constructor and refresh. */
  private loadPolicy(): void {
    // Managed source (admin-privileged): registry on Windows, managed prefs on macOS, system path on Linux
    const managedPolicy =
      readRegistryPolicy(this.platform) ??
      readManagedPrefsPolicy(this.platform) ??
      readLinuxSystemPolicy(this.platform);

    if (managedPolicy) {
      // Managed source is authoritative — ignore the user-writable file
      this.policy = managedPolicy;
      this.managed = true;
      log.info("Loaded managed policy:", JSON.stringify(managedPolicy));
    } else {
      // Fallback: disk file (for dev, script-based deployment)
      const filePolicy = this.loadFromFile();
      if (!isEmpty(filePolicy)) {
        this.policy = filePolicy;
        this.managed = true;
      } else {
        this.policy = EMPTY_POLICY;
        this.managed = false;
      }
    }
  }

  private loadFromFile(): TenantPolicy {
    try {
      if (!fs.existsSync(this.policyPath)) return EMPTY_POLICY;
      const raw = JSON.parse(fs.readFileSync(this.policyPath, "utf-8")); // SF-4: validated — sanitize() applies whitelist checks below
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        log.warn("tenant-policy.json: expected object, got", typeof raw);
        return EMPTY_POLICY;
      }
      // raw is narrowed to non-null, non-array object by the guard above
      return sanitize(raw as Record<string, unknown>); // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by typeof/null/Array.isArray checks above
    } catch (err) {
      log.warn("Failed to load tenant policy:", err);
      return EMPTY_POLICY;
    }
  }
}
