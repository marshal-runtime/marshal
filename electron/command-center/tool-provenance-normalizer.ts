import { createHash } from "node:crypto";
import path from "node:path";

import { isLocalFileToolName } from "../../common/tool-names";

export type NormalizedToolDomain = "unknown" | "filesystem" | "shell" | "browser";

export type NormalizedToolStatus = "started" | "succeeded" | "failed";

export interface PrivacyNormalizerOptions {
  hashSalt?: string;
}

export interface ToolProvenanceDraft {
  toolCallId: string;
  toolName: string;
  serverName?: string;
  args?: unknown;
  result?: unknown;
  success?: boolean;
  error?: unknown;
  startedAtMs?: number;
  completedAtMs?: number;
}

export interface NormalizedFileMetadata {
  operation: string;
  pathCount?: number;
  pathHashes?: string[];
  basenameHashes?: string[];
  extensions?: string[];
  contentHash?: string;
}

export interface NormalizedShellMetadata {
  commandHash?: string;
  category: string;
}

export interface NormalizedBrowserMetadata {
  action: string;
  actionHash?: string;
  urlScheme?: string;
  urlOriginHash?: string;
}

export type DomainMetadata =
  | { domain: "unknown" }
  | { domain: "filesystem"; file: NormalizedFileMetadata }
  | { domain: "shell"; shell: NormalizedShellMetadata }
  | { domain: "browser"; browser: NormalizedBrowserMetadata };

export type NormalizedToolProvenance = {
  type: "command-center.tool-provenance";
  toolCallId: string;
  toolName: string;
  serverName?: string;
  argKeys: string[];
  argsHash?: string;
  resultHash?: string;
  status: NormalizedToolStatus;
  durationMs?: number;
  errorClass?: string;
} & DomainMetadata;

const HASH_PREFIX = "sha256:";
const MAX_HASHES = 25;
const RAW_CONTENT_KEYS = new Set([
  "body",
  "content",
  "contents",
  "description",
  "diff",
  "html",
  "message",
  "preview",
  "prompt",
  "query",
  "script",
  "snapshot",
  "subject",
  "text",
  "title",
]);
const PATH_KEYS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "filePath",
  "filePaths",
  "source",
  "sourcePath",
  "destination",
  "destinationPath",
  "target",
  "targetPath",
]);

export function normalizeToolProvenance(
  draft: ToolProvenanceDraft,
  options: PrivacyNormalizerOptions = {},
): NormalizedToolProvenance {
  const argKeys = objectKeys(draft.args);
  const base = {
    type: "command-center.tool-provenance" as const,
    toolCallId: draft.toolCallId,
    toolName: draft.toolName,
    ...(draft.serverName ? { serverName: draft.serverName } : {}),
    argKeys,
    ...(draft.args !== undefined ? { argsHash: hashUnknown(draft.args, options) } : {}),
    ...(draft.result !== undefined ? { resultHash: hashUnknown(draft.result, options) } : {}),
    status: normalizeStatus(draft),
    ...(durationMs(draft) !== undefined ? { durationMs: durationMs(draft) } : {}),
    ...(draft.error !== undefined ? { errorClass: errorClass(draft.error) } : {}),
  };

  const domain = detectDomain(draft.toolName, draft.serverName);
  switch (domain) {
    case "filesystem":
      return { ...base, domain, file: normalizeFileMetadata(draft, options) };
    case "shell":
      return { ...base, domain, shell: normalizeShellMetadata(draft, options) };
    case "browser":
      return { ...base, domain, browser: normalizeBrowserMetadata(draft, options) };
    case "unknown":
      return { ...base, domain };
  }
  return { ...base, domain: "unknown" };
}

export function normalizeToolSnapshot(
  drafts: readonly ToolProvenanceDraft[],
  options: PrivacyNormalizerOptions = {},
): NormalizedToolProvenance[] {
  return drafts.map((draft) => normalizeToolProvenance(draft, options));
}

export function hashUnknown(value: unknown, options: PrivacyNormalizerOptions = {}): string {
  return hashString(stableStringify(value), options);
}

function normalizeStatus(draft: ToolProvenanceDraft): NormalizedToolStatus {
  if (draft.success === true) return "succeeded";
  if (draft.success === false || draft.error !== undefined) return "failed";
  return "started";
}

function durationMs(draft: ToolProvenanceDraft): number | undefined {
  if (typeof draft.startedAtMs !== "number" || typeof draft.completedAtMs !== "number") {
    return undefined;
  }
  return Math.max(0, Math.round(draft.completedAtMs - draft.startedAtMs));
}

function errorClass(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  if (typeof error === "object" && error !== null) {
    const name = getString(error, ["name", "code", "type"]);
    if (name) return safeCategory(name);
  }
  return typeof error;
}

function detectDomain(toolName: string, serverName?: string): NormalizedToolDomain {
  const label = `${serverName ?? ""} ${toolName}`.toLowerCase();
  if (label.includes("filesystem") || isFilesystemTool(toolName)) return "filesystem";
  if (label.includes("playwright") || toolName.startsWith("browser_")) return "browser";
  if (label.includes("shell") || label.includes("powershell") || label.includes("bash"))
    return "shell";
  return "unknown";
}

function normalizeFileMetadata(
  draft: ToolProvenanceDraft,
  options: PrivacyNormalizerOptions,
): NormalizedFileMetadata {
  const paths = collectStringValues(draft.args, PATH_KEYS);
  const content = collectRawContentCandidates(draft.args);
  const resultContent = collectRawContentCandidates(draft.result);
  const contentHashSource = firstString([...content, ...resultContent]);
  const pathMetas = paths.slice(0, MAX_HASHES).map((filePath) => pathMetadata(filePath, options));

  return {
    operation: filesystemOperation(draft.toolName),
    pathCount: paths.length || undefined,
    pathHashes: unique(pathMetas.map((meta) => meta.pathHash)),
    basenameHashes: unique(pathMetas.map((meta) => meta.basenameHash)),
    extensions: unique(pathMetas.map((meta) => meta.extension).filter(isNonEmptyString)),
    contentHash: contentHashSource ? hashString(contentHashSource, options) : undefined,
  };
}

function normalizeShellMetadata(
  draft: ToolProvenanceDraft,
  options: PrivacyNormalizerOptions,
): NormalizedShellMetadata {
  const command = getString(draft.args, ["command", "cmd", "script", "input"]);
  return {
    commandHash: command ? hashString(command, options) : undefined,
    category: command ? shellCategory(command) : "unknown",
  };
}

function normalizeBrowserMetadata(
  draft: ToolProvenanceDraft,
  options: PrivacyNormalizerOptions,
): NormalizedBrowserMetadata {
  const url = getString(draft.args, ["url"]);
  const parsed = parseUrl(url);
  return {
    action: browserAction(draft.toolName),
    actionHash: draft.args !== undefined ? hashUnknown(draft.args, options) : undefined,
    urlScheme: parsed?.protocol.replace(":", ""),
    urlOriginHash: parsed ? hashString(parsed.origin, options) : undefined,
  };
}

function isFilesystemTool(toolName: string): boolean {
  if (isLocalFileToolName(toolName)) return true;
  return [
    "read_file",
    "read_multiple_files",
    "write_file",
    "edit_file",
    "create_directory",
    "list_directory",
    "directory_tree",
    "move_file",
    "search_files",
    "get_file_info",
    "list_allowed_directories",
  ].includes(toolName);
}

function filesystemOperation(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("read")) return "read";
  if (normalized.includes("write") || normalized.includes("edit")) return "write";
  if (normalized.includes("create")) return "create";
  if (normalized.includes("move")) return "move";
  if (normalized.includes("search")) return "search";
  if (normalized.includes("list") || normalized.includes("tree")) return "list";
  if (normalized.includes("info") || normalized.includes("stat")) return "metadata";
  return "unknown";
}

function shellCategory(command: string): string {
  const lower = command.toLowerCase();
  if (/\b(curl|wget|irm|iwr|invoke-webrequest|invoke-restmethod)\b/.test(lower)) return "network";
  if (/\b(npm|pnpm|yarn|pip|go|cargo|dotnet|mvn|gradle)\b/.test(lower)) return "package";
  if (/\bgit\b/.test(lower)) return "git";
  if (/\b(rm|remove-item|del|erase|rmdir|move-item|copy-item|set-content|out-file)\b/.test(lower)) {
    return "filesystem-write";
  }
  if (/\b(cat|get-content|ls|get-childitem|rg|grep|findstr)\b/.test(lower))
    return "filesystem-read";
  if (/\b(start-process|stop-process|taskkill|kill)\b/.test(lower)) return "process";
  return "other";
}

function browserAction(toolName: string): string {
  const action = toolName.replace(/^browser_/, "");
  if (["navigate", "navigate_back", "tabs", "close", "resize", "wait_for"].includes(action)) {
    return action;
  }
  if (
    ["click", "hover", "drag", "type", "press_key", "fill_form", "select_option"].includes(action)
  ) {
    return "interaction";
  }
  if (["snapshot", "take_screenshot", "console_messages", "network_requests"].includes(action)) {
    return "observation";
  }
  if (["evaluate", "run_code"].includes(action)) return "script";
  if (["file_upload", "handle_dialog"].includes(action)) return "dialog-or-file";
  return "unknown";
}

function pathMetadata(filePath: string, options: PrivacyNormalizerOptions) {
  const basename = path.basename(filePath);
  const extension = path.extname(basename).toLowerCase();
  return {
    pathHash: hashString(filePath, options),
    basenameHash: hashString(basename, options),
    extension: extension || undefined,
  };
}

function objectKeys(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value).sort();
}

function getString(value: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  const record = value;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

function collectStringValues(value: unknown, keys: ReadonlySet<string>): string[] {
  const out: string[] = [];
  walk(value, (key, candidate) => {
    if (!key || !keys.has(key)) return;
    if (typeof candidate === "string") out.push(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === "string") out.push(item);
      }
    }
  });
  return out;
}

function collectRawContentCandidates(value: unknown): string[] {
  const out: string[] = [];
  walk(value, (key, candidate) => {
    if (!key || !RAW_CONTENT_KEYS.has(key) || typeof candidate !== "string") return;
    out.push(candidate);
  });
  return out;
}

function walk(
  value: unknown,
  visit: (key: string | undefined, value: unknown) => void,
  key?: string,
): void {
  visit(key, value);
  if (!isRecord(value) && !Array.isArray(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  for (const [childKey, child] of Object.entries(value)) {
    walk(child, visit, childKey);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!isRecord(value)) return "{}";
  const record = value;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashString(value: string, options: PrivacyNormalizerOptions): string {
  const hash = createHash("sha256");
  if (options.hashSalt) hash.update(options.hashSalt);
  hash.update("\0");
  hash.update(value);
  return `${HASH_PREFIX}${hash.digest("hex")}`;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function firstString(values: readonly string[]): string | undefined {
  return values.find((value) => value.length > 0);
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseUrl(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function safeCategory(value: string): string {
  return value.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80) || "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
