import { execFile } from "node:child_process";
import path from "node:path";

import type { RunningToolCallInfo } from "../backend/ports";

export interface GoalMaintenanceSessionInfo {
  id: string;
  name: string;
  source?: string;
  updatedAt?: string;
  active: boolean;
  busy: boolean;
  workspacePath?: string;
  worktree: boolean;
}

export interface GoalMaintenanceProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
  rssBytes: number;
}

export interface AttributedGoalProcess {
  pid: number;
  parentPid: number;
  name: string;
  rssBytes: number;
  sessionIds: string[];
  attribution: "workspace-path" | "descendant-of-workspace-process";
}

export interface GoalMaintenanceSnapshotInput {
  sessions: GoalMaintenanceSessionInfo[];
  runningTools: RunningToolCallInfo[];
  processes: GoalMaintenanceProcessInfo[];
  processQueryError?: string;
}

const MAX_SESSIONS = 40;
const MAX_TOOLS = 40;
const MAX_PROCESSES = 30;
const PROCESS_CACHE_TTL_MS = 30_000;
let processCache: { capturedAt: number; processes: GoalMaintenanceProcessInfo[] } | null = null;
let processQuery: Promise<GoalMaintenanceProcessInfo[]> | null = null;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function commandReferencesPath(commandLine: string, workspacePath: string): boolean {
  const normalizedPath = normalizeForMatch(path.resolve(workspacePath)).replace(/\/$/, "");
  return normalizedPath.length > 2 && normalizeForMatch(commandLine).includes(normalizedPath);
}

export function attributeProcessesToSessions(
  sessions: GoalMaintenanceSessionInfo[],
  processes: GoalMaintenanceProcessInfo[],
): AttributedGoalProcess[] {
  const ownersByPid = new Map<number, Set<string>>();
  const directMatches = new Set<number>();
  for (const processInfo of processes) {
    const owners = sessions
      .filter(
        (session) =>
          session.workspacePath &&
          commandReferencesPath(processInfo.commandLine, session.workspacePath),
      )
      .map((session) => session.id);
    if (owners.length === 0) continue;
    ownersByPid.set(processInfo.pid, new Set(owners));
    directMatches.add(processInfo.pid);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes) {
      if (ownersByPid.has(processInfo.pid)) continue;
      const parentOwners = ownersByPid.get(processInfo.parentPid);
      if (!parentOwners) continue;
      ownersByPid.set(processInfo.pid, new Set(parentOwners));
      changed = true;
    }
  }

  return processes
    .filter((processInfo) => ownersByPid.has(processInfo.pid))
    .map((processInfo) => ({
      pid: processInfo.pid,
      parentPid: processInfo.parentPid,
      name: processInfo.name,
      rssBytes: processInfo.rssBytes,
      sessionIds: [...ownersByPid.get(processInfo.pid)!].sort(),
      attribution: directMatches.has(processInfo.pid)
        ? ("workspace-path" as const)
        : ("descendant-of-workspace-process" as const),
    }))
    .sort((left, right) => right.rssBytes - left.rssBytes || left.pid - right.pid);
}

export function formatGoalMaintenanceSnapshot(input: GoalMaintenanceSnapshotInput): string {
  const lines: string[] = [];
  const sessions = input.sessions.slice(0, MAX_SESSIONS);
  lines.push(`- Parent/descendant sessions: ${input.sessions.length}`);
  for (const session of sessions) {
    const state = `${session.active ? "backend-active" : "backend-idle"}, ${
      session.busy ? "turn-busy" : "turn-idle"
    }`;
    lines.push(
      `  - ${session.id} | ${oneLine(session.name)} | ${session.source ?? "user"} | ${state}`,
    );
    if (session.workspacePath) {
      lines.push(`    ${session.worktree ? "worktree" : "workspace"}: ${session.workspacePath}`);
    }
  }
  if (input.sessions.length > sessions.length) {
    lines.push(`  - ... ${input.sessions.length - sessions.length} more sessions omitted`);
  }

  const runningTools = input.runningTools
    .filter((tool) => tool.status === "running")
    .slice(0, MAX_TOOLS);
  lines.push(`- Exact session-owned running tools: ${runningTools.length}`);
  for (const tool of runningTools) {
    lines.push(
      `  - ${tool.sessionId} | ${oneLine(tool.toolName)} | ${Math.round(tool.elapsedMs / 1000)}s | handle ${tool.handle}`,
    );
  }

  const attributed = attributeProcessesToSessions(input.sessions, input.processes).slice(
    0,
    MAX_PROCESSES,
  );
  lines.push(`- Path-attributed OS process candidates (heuristic): ${attributed.length}`);
  for (const processInfo of attributed) {
    lines.push(
      `  - PID ${processInfo.pid} | ${oneLine(processInfo.name)} | ${Math.round(
        processInfo.rssBytes / (1024 * 1024),
      )} MB RSS | ${processInfo.attribution} | sessions ${processInfo.sessionIds.join(",")}`,
    );
  }
  if (input.processQueryError) {
    lines.push(`  - Process inventory unavailable: ${oneLine(input.processQueryError)}`);
  }
  lines.push(
    "- Shared Copilot/MCP processes without workspace-path evidence are intentionally unassigned; Marshal does not yet receive per-tool child PIDs from the shared CLI.",
  );
  return lines.join("\n");
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function parseWindowsProcesses(stdout: string): GoalMaintenanceProcessInfo[] {
  const processes: GoalMaintenanceProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [pidRaw, parentPidRaw, name, rssRaw, commandLineBase64 = ""] = line.split("\t");
    const pid = Number(pidRaw);
    const parentPid = Number(parentPidRaw);
    const rssBytes = Number(rssRaw);
    if (!Number.isFinite(pid) || !Number.isFinite(parentPid) || !name) continue;
    let commandLine = "";
    try {
      commandLine = Buffer.from(commandLineBase64, "base64").toString("utf8");
    } catch {
      commandLine = "";
    }
    processes.push({
      pid,
      parentPid,
      name,
      commandLine,
      rssBytes: Number.isFinite(rssBytes) ? rssBytes : 0,
    });
  }
  return processes;
}

function parsePosixProcesses(stdout: string): GoalMaintenanceProcessInfo[] {
  const processes: GoalMaintenanceProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      name: match[4],
      commandLine: match[5],
    });
  }
  return processes;
}

async function queryGoalMaintenanceProcesses(): Promise<GoalMaintenanceProcessInfo[]> {
  if (process.platform === "win32") {
    const script = [
      "$encoding = [Text.Encoding]::UTF8",
      "Get-CimInstance Win32_Process | ForEach-Object {",
      "  $command = if ($_.CommandLine) { [Convert]::ToBase64String($encoding.GetBytes([string]$_.CommandLine)) } else { '' }",
      '  "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.WorkingSetSize)`t$command"',
      "}",
    ].join("\n");
    return parseWindowsProcesses(
      await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]),
    );
  }
  return parsePosixProcesses(await execFileText("ps", ["-axo", "pid=,ppid=,rss=,comm=,args="]));
}

export async function collectGoalMaintenanceProcesses(): Promise<GoalMaintenanceProcessInfo[]> {
  const now = Date.now();
  if (processCache && now - processCache.capturedAt < PROCESS_CACHE_TTL_MS) {
    return processCache.processes;
  }
  if (processQuery) return processQuery;

  const query = queryGoalMaintenanceProcesses().then((processes) => {
    processCache = { capturedAt: Date.now(), processes };
    return processes;
  });
  processQuery = query;
  try {
    return await query;
  } finally {
    if (processQuery === query) processQuery = null;
  }
}
