import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type {
  CommandCenterSessionActivityDetails,
  CommandCenterSessionActivityFileChange,
  CommandCenterSessionActivitySource,
  SessionMetadata,
} from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import { getAppDataDir } from "../app-paths";
import { readEncryptedFileSync, writeEncryptedFile } from "../safe-storage-file";

const log = createLogger("CommandCenterActivityDetailStore");

interface ToolStartInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  serverName?: string;
  args?: unknown;
}

interface ToolResultInput extends ToolStartInput {
  result: unknown;
}

interface ActivityFileBaseline {
  sessionId: string;
  path: string;
  label: string;
  toolName: string;
  exists: boolean;
  content?: string;
  sourceTooLarge?: boolean;
  updatedAt: number;
}

interface SessionActivityData {
  fileChanges: CommandCenterSessionActivityFileChange[];
  sources: CommandCenterSessionActivitySource[];
  fileBaselines?: Record<string, ActivityFileBaseline>;
  lastActivityAt?: number;
}

interface StoreData {
  sessions: Record<string, SessionActivityData>;
}

const EMPTY_STORE: StoreData = { sessions: {} };
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
const URL_KEYS = new Set(["url", "webUrl", "htmlUrl", "remoteUrl", "link", "href"]);
const WORKING_DIR_KEYS = new Set(["cwd", "workingDirectory", "workspaceDir", "repoPath", "root"]);
const MAX_DIFF_BYTES = 64 * 1024;
const MAX_DIFF_SOURCE_BYTES = 512 * 1024;
const DIFF_CONTEXT_LINES = 3;
const MAX_FILE_CHANGES_PER_SESSION = 200;
const MAX_SOURCES_PER_SESSION = 200;
// The whole store is serialized and encrypted on main per write; unbounded
// growth (104 MB on 2026-10-17) froze the main loop for 5-40s per save.
const MAX_SESSIONS = 300;
const MAX_BASELINES_PER_SESSION = MAX_FILE_CHANGES_PER_SESSION;
const BASELINE_RETENTION_MS = 6 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 2_000;

type ActivityDiffUnavailableReason = NonNullable<
  CommandCenterSessionActivityFileChange["diffUnavailableReason"]
>;

interface ActivityFileSnapshot {
  exists: boolean;
  content?: string;
  sourceTooLarge?: boolean;
}

interface ActivityFileDiff {
  diff?: string;
  lineCounts: { additions: number; deletions: number };
  diffUnavailableReason?: ActivityDiffUnavailableReason;
  diffContextLines?: number;
}

export class CommandCenterActivityDetailStore {
  private data: StoreData = { sessions: {} };
  private generation = 0;
  private persistedGeneration = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = path.join(
      getAppDataDir(),
      "marshal-command-center",
      "activity-details.json.enc",
    ),
  ) {}

  reload(): void {
    // Memory is newer than disk until the pending write lands.
    if (this.generation !== this.persistedGeneration) return;
    this.data = this.load();
    if (pruneStore(this.data, Date.now())) this.save();
  }

  /** Write any pending changes now. Called on quit and by tests. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.writePending();
  }

  recordToolStart(input: ToolStartInput): void {
    this.recordToolActivity(input);
  }

  recordToolResult(input: ToolResultInput): void {
    this.recordToolActivity(input);
  }

  private recordToolActivity(input: ToolStartInput | ToolResultInput): void {
    const now = Date.now();
    const payloads = toolPayloads(input);
    const diff = firstDefined(payloads.map(extractPatch));
    const patchFiles = diff ? extractPatchFiles(diff).flatMap(expandPathCandidate) : [];
    const explicitPaths = payloads.flatMap((payload) =>
      collectStringsByKey(payload, PATH_KEYS).flatMap(expandPathCandidate),
    );
    const paths = patchFiles.length > 0 ? patchFiles : explicitPaths;
    const workingDirs = payloads.flatMap((payload) =>
      collectStringsByKey(payload, WORKING_DIR_KEYS).flatMap(expandPathCandidate),
    );
    const uniquePaths = unique(paths);
    let changed = false;
    let session: StoreData["sessions"][string] | undefined;
    const ensureChangedSession = () => {
      changed = true;
      session ??= this.ensureSession(input.sessionId);
      session.lastActivityAt = now;
      return session;
    };

    const fileChangingTool = isFileChangingTool(input.toolName) || patchFiles.length > 0;
    if (!("result" in input) && fileChangingTool && uniquePaths.length > 0) {
      const changedSession = ensureChangedSession();
      changedSession.fileBaselines ??= {};
      for (const filePath of uniquePaths) {
        const resolvedPath = resolveActivityPath(filePath, workingDirs);
        const key = fileChangeIdentityKey(resolvedPath);
        if (!changedSession.fileBaselines[key]) {
          changedSession.fileBaselines[key] = readFileBaseline(
            input.sessionId,
            input.toolName,
            resolvedPath,
            now,
          );
        }
      }
    }

    if ("result" in input && fileChangingTool) {
      for (const filePath of uniquePaths) {
        const resolvedPath = resolveActivityPath(filePath, workingDirs);
        const changedSession = ensureChangedSession();
        const baseline = changedSession.fileBaselines?.[fileChangeIdentityKey(resolvedPath)];
        const baselineDiff = baseline ? readBaselineFileDiff(baseline, resolvedPath) : undefined;
        const toolDiff = baseline ? undefined : buildToolArgumentDiff(resolvedPath, payloads, diff);
        const fileDiff = baselineDiff ?? toolDiff;
        const lineCounts = fileDiff?.lineCounts ?? {
          additions: 0,
          deletions: 0,
        };
        const id = fileChangeId(input.sessionId, resolvedPath);
        if (
          !fileDiff?.diff &&
          !fileDiff?.diffUnavailableReason &&
          lineCounts.additions === 0 &&
          lineCounts.deletions === 0
        ) {
          removeById(changedSession.fileChanges, id);
          continue;
        }
        upsertById(changedSession.fileChanges, {
          id,
          sessionId: input.sessionId,
          path: resolvedPath,
          label: path.basename(resolvedPath) || resolvedPath,
          toolName: input.toolName,
          additions: lineCounts.additions,
          deletions: lineCounts.deletions,
          ...(fileDiff ? fileChangeDiffFields(fileDiff) : {}),
          updatedAt: now,
        });
      }
    }

    const source = normalizeActivitySource(sourceFromTool(input, payloads, now));
    if (source) {
      upsertById(ensureChangedSession().sources, source);
    }

    if (changed && session) {
      trimNewestByUpdatedAt(session.fileChanges, MAX_FILE_CHANGES_PER_SESSION);
      trimNewestByUpdatedAt(session.sources, MAX_SOURCES_PER_SESSION);
      this.save();
    }
  }

  getSessionActivity(
    rootSessionId: string,
    sessions: readonly SessionMetadata[],
  ): CommandCenterSessionActivityDetails {
    const sessionIds = collectSessionTree(rootSessionId, sessions);
    const fileChanges = sessionIds.flatMap((id) => this.data.sessions[id]?.fileChanges ?? []);
    const sources = dedupeSources(
      sessionIds.flatMap((id) => this.data.sessions[id]?.sources ?? []),
    );
    return {
      rootSessionId,
      sessionIds,
      safeSessionIds: [],
      fileChanges: dedupeFileChanges(fileChanges).sort(compareUpdated),
      sources: sources.sort(compareUpdated),
    };
  }

  private ensureSession(sessionId: string): SessionActivityData {
    const existing = this.data.sessions[sessionId];
    if (existing) {
      existing.fileBaselines ??= {};
      return existing;
    }
    const created: SessionActivityData = { fileChanges: [], sources: [], fileBaselines: {} };
    this.data.sessions[sessionId] = created;
    return created;
  }

  private load(): StoreData {
    try {
      const parsed: unknown = JSON.parse(readEncryptedFileSync(this.filePath)); // SF-4: guarded by isStoreData before use.
      if (isStoreData(parsed)) return parsed;
      return { ...EMPTY_STORE };
    } catch {
      return { ...EMPTY_STORE };
    }
  }

  private save(): void {
    this.generation++;
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.writePending();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private writePending(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const generation = this.generation;
      if (generation === this.persistedGeneration) return;
      pruneStore(this.data, Date.now());
      try {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await writeEncryptedFile(this.filePath, JSON.stringify(this.data));
        this.persistedGeneration = generation;
      } catch (err) {
        log.warn("Failed to persist command center activity details:", err);
      }
      if (this.generation !== this.persistedGeneration) this.scheduleWrite();
    });
    return this.writeChain;
  }
}

function sessionLastActivityAt(session: SessionActivityData): number {
  if (typeof session.lastActivityAt === "number") return session.lastActivityAt;
  let latest = 0;
  for (const item of [
    ...(session.fileChanges ?? []),
    ...(session.sources ?? []),
    ...Object.values(session.fileBaselines ?? {}),
  ]) {
    if (typeof item?.updatedAt === "number" && item.updatedAt > latest) latest = item.updatedAt;
  }
  return latest;
}

/**
 * Bound the store: keep the most recently active sessions, and drop file
 * baselines (full file snapshots) once a session has gone quiet, since the
 * recorded diffs already live in `fileChanges`. Returns whether anything changed.
 */
function pruneStore(data: StoreData, now: number): boolean {
  let changed = false;
  const ranked = Object.entries(data.sessions)
    .map(([id, session]) => ({ id, session, at: sessionLastActivityAt(session) }))
    .sort((a, b) => b.at - a.at);
  for (const { id } of ranked.slice(MAX_SESSIONS)) {
    delete data.sessions[id];
    changed = true;
  }
  for (const { session, at } of ranked.slice(0, MAX_SESSIONS)) {
    session.lastActivityAt ??= at;
    const baselines = session.fileBaselines;
    if (!baselines) continue;
    const keys = Object.keys(baselines);
    if (keys.length === 0) continue;
    if (now - at > BASELINE_RETENTION_MS) {
      session.fileBaselines = {};
      changed = true;
      continue;
    }
    if (keys.length > MAX_BASELINES_PER_SESSION) {
      keys
        .sort((a, b) => (baselines[b]?.updatedAt ?? 0) - (baselines[a]?.updatedAt ?? 0))
        .slice(MAX_BASELINES_PER_SESSION)
        .forEach((key) => delete baselines[key]);
      changed = true;
    }
  }
  return changed;
}

function dedupeSources(
  sources: CommandCenterSessionActivitySource[],
): CommandCenterSessionActivitySource[] {
  const byKey = new Map<string, CommandCenterSessionActivitySource>();
  for (const source of sources
    .flatMap((candidate) => normalizeActivitySource(candidate) ?? [])
    .sort(compareUpdated)) {
    const key = sourceDedupeKey(source);
    const existing = byKey.get(key);
    if (!existing || source.updatedAt > existing.updatedAt) byKey.set(key, source);
  }
  return [...byKey.values()].sort(compareUpdated);
}

function dedupeFileChanges(
  fileChanges: CommandCenterSessionActivityFileChange[],
): CommandCenterSessionActivityFileChange[] {
  const latestChangeByPath = new Map<string, CommandCenterSessionActivityFileChange>();
  for (const change of fileChanges.sort((a, b) => a.updatedAt - b.updatedAt)) {
    latestChangeByPath.set(aggregateFileChangeKey(change.sessionId, change.path), change);
  }
  return [...latestChangeByPath.values()].map((change) => ({
    ...change,
    id: fileChangeId(change.sessionId, change.path),
  }));
}

function trimNewestByUpdatedAt(items: Array<{ updatedAt: number }>, maxItems: number): void {
  if (items.length <= maxItems) return;
  items.sort(compareUpdated);
  items.splice(maxItems);
}

function fileChangeDiffFields(
  diff: ActivityFileDiff,
): Partial<
  Pick<
    CommandCenterSessionActivityFileChange,
    "diff" | "diffTruncated" | "diffUnavailableReason" | "diffContextLines"
  >
> {
  const fields: Partial<
    Pick<
      CommandCenterSessionActivityFileChange,
      "diff" | "diffTruncated" | "diffUnavailableReason" | "diffContextLines"
    >
  > = {};
  if (diff.diff) {
    const truncated = truncateUtf8(diff.diff, MAX_DIFF_BYTES);
    fields.diff = truncated.value;
    if (truncated.truncated) fields.diffTruncated = true;
  }
  if (diff.diffUnavailableReason) fields.diffUnavailableReason = diff.diffUnavailableReason;
  if (diff.diffContextLines !== undefined) fields.diffContextLines = diff.diffContextLines;
  return fields;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  const suffix = "\n...[truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes - suffixBytes) low = mid;
    else high = mid - 1;
  }
  return { value: `${value.slice(0, low)}${suffix}`, truncated: true };
}

function sourceDedupeKey(source: CommandCenterSessionActivitySource): string {
  if (source.kind === "pr") {
    const id =
      source.label.match(/\b(?:pull request\s*)?(\d{1,})\b/i)?.[1] ??
      source.id.match(/pr:(\d{1,})\b/i)?.[1] ??
      source.url?.match(/\/pullrequest\/(\d{1,})\b/i)?.[1] ??
      source.url?.match(/pullRequests\/(\d{1,})\b/i)?.[1];
    if (id) return `${source.sessionId}:pr:${id}`;
  }
  if (source.url) return `${source.sessionId}:${source.kind}:${source.url}`;
  return `${source.sessionId}:${source.kind}:${source.label}:${source.toolName}`;
}

function collectSessionTree(rootSessionId: string, sessions: readonly SessionMetadata[]): string[] {
  const byParent = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const children = byParent.get(session.parentSessionId) ?? [];
    children.push(session.id);
    byParent.set(session.parentSessionId, children);
  }

  const seen = new Set<string>();
  const queue = [rootSessionId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    queue.push(...(byParent.get(id) ?? []));
  }
  return [...seen];
}

function sourceFromTool(
  input: ToolStartInput | ToolResultInput,
  payloads: unknown[],
  updatedAt: number,
): CommandCenterSessionActivitySource | null {
  const label = `${input.serverName ?? ""} ${input.toolName}`.toLowerCase();
  const urls = unique(payloads.flatMap((payload) => collectStringsByKey(payload, URL_KEYS)));
  const query = firstStringByKey(payloads, ["query"]);
  const genericId = firstStringByKey(payloads, ["id"]);
  let pullRequestId = firstStringByKey(payloads, ["pullRequestId", "pull_request_id", "prId"]);
  const hasPullRequestShape =
    pullRequestId !== undefined ||
    urls.some((url) => /(?:\/pullrequest\/|pullRequests\/)/i.test(url)) ||
    label.includes("pull_request") ||
    label.includes("pullrequest") ||
    label.includes("pull request");
  let kind: CommandCenterSessionActivitySource["kind"] | null = null;
  if (label.includes("email")) kind = "email";
  else if (hasPullRequestShape) kind = "pr";
  if (!kind) return null;
  if (kind === "pr") pullRequestId ??= genericId;
  const url = selectSourceUrl(kind, urls);

  return {
    id: sourceId(input, kind, pullRequestId, url),
    sessionId: input.sessionId,
    kind,
    label: sourceLabel(kind, input.toolName, url, pullRequestId),
    toolName: input.toolName,
    ...(url ? { url } : {}),
    ...(query ? { query } : {}),
    updatedAt,
  };
}

function sourceId(
  input: ToolStartInput | ToolResultInput,
  kind: CommandCenterSessionActivitySource["kind"],
  pullRequestId?: string,
  url?: string,
): string {
  if (kind === "pr" && pullRequestId) return `${input.sessionId}:pr:${pullRequestId}`;
  if (url) return `${input.sessionId}:${kind}:${url}`;
  return `${input.toolCallId}:${kind}`;
}

function selectSourceUrl(
  kind: CommandCenterSessionActivitySource["kind"],
  urls: string[],
): string | undefined {
  if (kind === "pr") {
    const prWebUrl = urls.find((url) => /\/pullrequest\//i.test(url));
    if (prWebUrl) return prWebUrl;
  }
  return urls[0];
}

// Removed source kinds can still be persisted in activity-details.json.enc;
// surface them as "other" rather than dropping the stored record.
const LEGACY_SOURCE_KINDS: ReadonlySet<string> = new Set(["ado", "kusto", "m365"]);

function normalizeActivitySource(
  source: CommandCenterSessionActivitySource | null,
): CommandCenterSessionActivitySource | null {
  if (!source) return null;
  const kind: string = source.kind;
  return LEGACY_SOURCE_KINDS.has(kind) ? { ...source, kind: "other" } : source;
}

function sourceLabel(
  kind: CommandCenterSessionActivitySource["kind"],
  toolName: string,
  url?: string,
  pullRequestId?: string,
): string {
  if (kind === "pr" && pullRequestId) return `Pull request ${pullRequestId}`;
  if (url) return url;
  return toolName;
}

function isFileChangingTool(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return (
    lower.includes("apply_patch") ||
    lower.includes("write") ||
    lower.includes("edit") ||
    lower.includes("move") ||
    lower.includes("mkdir") ||
    lower.includes("create")
  );
}

function extractPatch(args: unknown): string | undefined {
  for (const key of ["patch", "diff", "input"]) {
    const value = firstStringByKey(args, [key]);
    if (value?.includes("*** Begin Patch")) return value;
  }
  const strings = collectStrings(args);
  return strings.find((value) => value.includes("*** Begin Patch"));
}

function extractPatchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match?.[1]) files.push(match[1].trim());
  }
  return files;
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("***")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function fileChangeIdentityKey(filePath: string): string {
  const normalized = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.normalize(normalizePathCandidate(filePath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function aggregateFileChangeKey(sessionId: string, filePath: string): string {
  return `${sessionId}:${fileChangeIdentityKey(filePath)}`;
}

function fileChangeId(sessionId: string, filePath: string): string {
  return `${sessionId}:file:${fileChangeIdentityKey(filePath)}`;
}

function resolveActivityPath(filePath: string, workingDirs: string[]): string {
  const normalizedPath = normalizePathCandidate(filePath);
  if (path.isAbsolute(normalizedPath)) return path.normalize(normalizedPath);
  const base = workingDirs.find((dir) => path.isAbsolute(dir));
  return base ? path.normalize(path.join(base, normalizedPath)) : normalizedPath;
}

function expandPathCandidate(value: string): string[] {
  const parsed = parsePathCandidateValue(value);
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) => (typeof entry === "string" ? expandPathCandidate(entry) : []));
  }
  return typeof parsed === "string" ? [normalizePathCandidate(parsed)] : [];
}

function normalizePathCandidate(value: string): string {
  const parsed = parsePathCandidateValue(value);
  if (Array.isArray(parsed)) {
    const first = parsed.find((entry): entry is string => typeof entry === "string");
    return first ? normalizePathCandidate(first) : value.trim();
  }
  const text = typeof parsed === "string" ? parsed : value;
  return text.trim().replace(/^['"]|['"]$/g, "");
}

function parsePathCandidateValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  try {
    return JSON.parse(trimmed) as unknown; // SF-4: tool path candidate parsed as unknown and type-checked before use.
  } catch {
    return trimmed;
  }
}

function readFileBaseline(
  sessionId: string,
  toolName: string,
  filePath: string,
  updatedAt: number,
): ActivityFileBaseline {
  const snapshot = readFileSnapshot(filePath);
  return {
    sessionId,
    path: filePath,
    label: path.basename(filePath) || filePath,
    toolName,
    exists: snapshot.exists,
    ...(snapshot.content !== undefined ? { content: snapshot.content } : {}),
    ...(snapshot.sourceTooLarge ? { sourceTooLarge: true } : {}),
    updatedAt,
  };
}

function readBaselineFileDiff(
  baseline: ActivityFileBaseline,
  filePath: string,
): ActivityFileDiff | undefined {
  const current = readFileSnapshot(filePath);
  if (
    baseline.sourceTooLarge ||
    current.sourceTooLarge ||
    (baseline.exists && baseline.content === undefined) ||
    (current.exists && current.content === undefined)
  ) {
    return {
      lineCounts: { additions: 0, deletions: 0 },
      diffUnavailableReason: "source-too-large",
    };
  }
  if (baseline.exists === current.exists && baseline.content === current.content) return undefined;
  const relativePath = diffDisplayPath(filePath);
  let diff = "";
  if (!baseline.exists && current.exists) {
    diff = buildAddedFileDiff(relativePath, current.content ?? "");
  } else if (baseline.exists && !current.exists) {
    diff = buildDeletedFileDiff(relativePath, baseline.content ?? "");
  } else if (baseline.exists && current.exists && baseline.content !== current.content) {
    diff = buildModifiedFileDiff(relativePath, baseline.content ?? "", current.content ?? "");
  }
  return { diff, lineCounts: countPatchLines(diff), diffContextLines: DIFF_CONTEXT_LINES };
}

function buildToolArgumentDiff(
  filePath: string,
  payloads: unknown[],
  patch: string | undefined,
): ActivityFileDiff | undefined {
  if (patch) return { diff: patch, lineCounts: countPatchLines(patch) };
  const relativePath = diffDisplayPath(filePath);
  const oldText = firstStringByKey(payloads, ["old_str", "oldStr", "oldString"]);
  const newText = firstStringByKey(payloads, ["new_str", "newStr", "newString"]);
  if (oldText !== undefined || newText !== undefined) {
    const diff =
      oldText === undefined
        ? buildAddedFileDiff(relativePath, newText ?? "")
        : newText === undefined
          ? buildDeletedFileDiff(relativePath, oldText)
          : buildModifiedFileDiff(relativePath, oldText, newText);
    return { diff, lineCounts: countPatchLines(diff) };
  }
  const content = firstStringByKey(payloads, ["content", "contents", "text"]);
  if (content !== undefined) {
    const diff = buildAddedFileDiff(relativePath, content);
    return { diff, lineCounts: countPatchLines(diff) };
  }
  return undefined;
}

function readFileSnapshot(filePath: string): ActivityFileSnapshot {
  if (!fs.existsSync(filePath)) return { exists: false };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { exists: false };
  if (stat.size > MAX_DIFF_SOURCE_BYTES) return { exists: true, sourceTooLarge: true };
  return { exists: true, content: fs.readFileSync(filePath, "utf-8") };
}

function diffDisplayPath(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  const startDir = fs.existsSync(absolutePath)
    ? fs.statSync(absolutePath).isDirectory()
      ? absolutePath
      : path.dirname(absolutePath)
    : path.dirname(absolutePath);
  const gitRoot = findGitRoot(startDir);
  if (gitRoot) return path.relative(gitRoot, absolutePath).replace(/\\/g, "/");
  return normalizePathCandidate(filePath).replace(/\\/g, "/");
}

function findGitRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function buildModifiedFileDiff(relativePath: string, before: string, after: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-activity-diff-"));
  try {
    const beforePath = path.join(tempDir, "before");
    const afterPath = path.join(tempDir, "after");
    fs.writeFileSync(beforePath, before, "utf-8");
    fs.writeFileSync(afterPath, after, "utf-8");
    const diff = runGitNoIndexDiff(beforePath, afterPath);
    if (diff.trim()) return normalizeNoIndexDiff(diff, relativePath);
    return buildFullRewriteDiff(relativePath, before, after);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runGitNoIndexDiff(beforePath: string, afterPath: string): string {
  const result = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--no-ext-diff",
      `--unified=${DIFF_CONTEXT_LINES}`,
      "--no-color",
      "--",
      beforePath,
      afterPath,
    ],
    {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (result.error) return "";
  return result.stdout;
}

function normalizeNoIndexDiff(diff: string, relativePath: string): string {
  let removedHeader = false;
  let addedHeader = false;
  return splitContentLines(diff)
    .map((line) => {
      if (line.startsWith("diff --git ")) return `diff --git a/${relativePath} b/${relativePath}`;
      if (!removedHeader && line.startsWith("--- ")) {
        removedHeader = true;
        return `--- a/${relativePath}`;
      }
      if (!addedHeader && line.startsWith("+++ ")) {
        addedHeader = true;
        return `+++ b/${relativePath}`;
      }
      return line;
    })
    .join("\n");
}

function buildAddedFileDiff(relativePath: string, content: string): string {
  const lines = splitContentLines(content);
  const body = lines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildDeletedFileDiff(relativePath: string, content: string): string {
  const lines = splitContentLines(content);
  const body = lines.map((line) => `-${line}`).join("\n");
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "deleted file mode 100644",
    `--- a/${relativePath}`,
    "+++ /dev/null",
    `@@ -1,${lines.length} +0,0 @@`,
    body,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildFullRewriteDiff(relativePath: string, before: string, after: string): string {
  const beforeLines = splitContentLines(before);
  const afterLines = splitContentLines(after);
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n");
}

function splitContentLines(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function firstStringByKey(value: unknown, keys: readonly string[]): string | undefined {
  const wanted = new Set(keys);
  const values = Array.isArray(value) ? value : [value];
  for (const entry of values) {
    const match = collectStringsByKey(entry, wanted)[0];
    if (match) return match;
  }
  return undefined;
}

function collectStringsByKey(value: unknown, keys: ReadonlySet<string>): string[] {
  const results: string[] = [];
  visit(value, (key, entry) => {
    if (key && keys.has(key) && typeof entry === "string" && entry.trim()) {
      results.push(entry.trim());
    }
    if (key && keys.has(key) && typeof entry === "number" && Number.isFinite(entry)) {
      results.push(String(entry));
    }
    if (key && keys.has(key) && Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === "string" && item.trim()) results.push(item.trim());
        if (typeof item === "number" && Number.isFinite(item)) results.push(String(item));
      }
    }
  });
  return results;
}

function collectStrings(value: unknown): string[] {
  const results: string[] = [];
  visit(value, (_key, entry) => {
    if (typeof entry === "string" && entry.trim()) results.push(entry.trim());
  });
  return results;
}

function toolPayloads(input: ToolStartInput | ToolResultInput): unknown[] {
  return "result" in input
    ? [input.args, input.result].map(normalizeToolPayload)
    : [normalizeToolPayload(input.args)];
}

function normalizeToolPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown; // SF-4: SDK tool payload string; parsed into unknown and traversed defensively.
  } catch {
    return value;
  }
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function visit(value: unknown, fn: (key: string | undefined, entry: unknown) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      fn(undefined, entry);
      visit(entry, fn);
    });
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    fn(key, entry);
    visit(entry, fn);
  }
}

function upsertById<T extends { id: string }>(items: T[], item: T): void {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) items[index] = item;
  else items.push(item);
}

function removeById(items: Array<{ id: string }>, id: string): void {
  const index = items.findIndex((existing) => existing.id === id);
  if (index >= 0) items.splice(index, 1);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compareUpdated<T extends { updatedAt: number }>(a: T, b: T): number {
  return b.updatedAt - a.updatedAt;
}

function isStoreData(value: unknown): value is StoreData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sessions = (value as { sessions?: unknown }).sessions;
  return !!sessions && typeof sessions === "object" && !Array.isArray(sessions);
}
