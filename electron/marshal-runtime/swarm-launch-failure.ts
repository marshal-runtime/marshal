import { WorktreeCreationError, classifyWorktreeCreationError } from "../worktree-creation-error";

export type SwarmLaunchFailureKind = "retryable-worktree" | "retryable-session-start" | "fatal";

export interface SwarmLaunchFailure {
  readonly kind: SwarmLaunchFailureKind;
  readonly retryable: boolean;
  readonly category: string;
  readonly code: string;
  readonly message: string;
}

interface FailureDetails {
  readonly codes: ReadonlySet<string>;
  readonly names: ReadonlySet<string>;
  readonly text: string;
  readonly chain: readonly object[];
}

/**
 * Terminal markers win over every retryable signal: a swarm launch that lost its
 * session, its worktree, or its caller must never be dispatched a second time.
 */
const TERMINAL_MARKERS: ReadonlyArray<{ readonly code: string; readonly pattern: RegExp }> = [
  { code: "ABORTED", pattern: /\babort(?:ed|ing)?\b|\bcancell?ed\b|operation was cancell?ed/ },
  { code: "STOPPED", pattern: /\bstopp(?:ed|ing)\b|\bshutting down\b|\bshutdown\b/ },
  { code: "STALE", pattern: /\bstale\b/ },
  {
    code: "DELETING",
    pattern: /\bdelet(?:ing|ed)\b|\bremoving\b|being removed|marked for (?:deletion|removal)/,
  },
];

const TERMINAL_CODES = new Set(["ABORT_ERR", "ERR_CANCELED", "ERR_CANCELLED"]);
const TERMINAL_NAMES = new Set(["AbortError", "SwarmRunStoppedError"]);

const RETRYABLE_SESSION_START_CODES = new Set([
  "EAGAIN",
  "EBUSY",
  "ECONNREFUSED",
  "ECONNRESET",
  "EMFILE",
  "ENFILE",
  "ENOMEM",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

const RETRYABLE_SESSION_START_PATTERN =
  /failed to (?:start|create|spawn) (?:a )?session|session (?:start|creation) failed|session did not start|did not become ready|not ready yet|timed? ?out|temporarily unavailable|resource busy|too many open files|socket hang up|connection reset|econnreset|backend is (?:not|un)available|exited unexpectedly|exited before/;

function readProperty(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function collectFailureDetails(error: unknown): FailureDetails {
  const codes = new Set<string>();
  const names = new Set<string>();
  const chain: object[] = [];
  const text: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  while (pending.length > 0) {
    const current = pending.shift();
    if (typeof current === "string") {
      text.push(current);
      continue;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);

    if (current instanceof Error) {
      text.push(current.message);
      names.add(current.name);
    }
    for (const key of ["name", "reason"]) {
      const value = readProperty(current, key);
      if (typeof value === "string") names.add(value);
    }
    for (const key of ["code", "errno"]) {
      const value = readProperty(current, key);
      if (typeof value === "string") codes.add(value.toUpperCase());
    }
    for (const key of ["message", "stderr", "stdout", "syscall", "path", "operation"]) {
      const value = readProperty(current, key);
      if (typeof value === "string") text.push(value);
    }
    for (const key of ["cause", "payload", "reason", "error"]) {
      const value = readProperty(current, key);
      if (value !== undefined && value !== null) pending.push(value);
    }
    const aggregated = readProperty(current, "errors");
    if (Array.isArray(aggregated)) pending.push(...aggregated);
  }

  return { codes, names, chain, text: text.join("\n").toLowerCase() };
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Unknown swarm launch failure";
}

function terminalCode(details: FailureDetails): string | undefined {
  for (const name of details.names) {
    if (TERMINAL_NAMES.has(name)) return "ABORTED";
  }
  for (const code of details.codes) {
    if (TERMINAL_CODES.has(code)) return "ABORTED";
  }
  for (const marker of TERMINAL_MARKERS) {
    if (marker.pattern.test(details.text)) return marker.code;
  }
  return undefined;
}

function worktreeCreationErrorIn(details: FailureDetails): WorktreeCreationError | undefined {
  for (const link of details.chain) {
    if (link instanceof WorktreeCreationError) return link;
  }
  return undefined;
}

/**
 * An environmental payload that already declares `retryable: false` has spent its
 * attempt budget in a lower layer; re-running it here would multiply the attempts.
 */
function exhaustedEnvironmentalFailure(
  details: FailureDetails,
): { readonly category: string; readonly code: string } | undefined {
  for (const link of details.chain) {
    if (readProperty(link, "kind") !== "environmental") continue;
    if (readProperty(link, "retryable") !== false) continue;
    const category = readProperty(link, "category");
    const code = readProperty(link, "code");
    return {
      category: typeof category === "string" ? category : "environmental",
      code: typeof code === "string" ? code : "UNKNOWN",
    };
  }
  return undefined;
}

function mentionsWorktree(details: FailureDetails): boolean {
  return details.text.includes("worktree") || details.text.includes("worktree.create");
}

export function classifySwarmLaunchFailure(error: unknown): SwarmLaunchFailure {
  const details = collectFailureDetails(error);
  const message = failureMessage(error);

  const terminal = terminalCode(details);
  if (terminal) {
    return { kind: "fatal", retryable: false, category: "terminal", code: terminal, message };
  }

  const exhausted = exhaustedEnvironmentalFailure(details);
  if (exhausted) {
    return {
      kind: "fatal",
      retryable: false,
      category: exhausted.category,
      code: exhausted.code,
      message,
    };
  }

  const worktreeError = worktreeCreationErrorIn(details);
  if (worktreeError) {
    return {
      kind: worktreeError.retryable ? "retryable-worktree" : "fatal",
      retryable: worktreeError.retryable,
      category: worktreeError.category,
      code: worktreeError.code,
      message,
    };
  }

  if (mentionsWorktree(details)) {
    const classified = classifyWorktreeCreationError(error);
    return {
      kind: classified.retryable ? "retryable-worktree" : "fatal",
      retryable: classified.retryable,
      category: classified.category,
      code: classified.code,
      message,
    };
  }

  if (error instanceof TypeError) {
    return {
      kind: "fatal",
      retryable: false,
      category: "invalid-request",
      code: "EINVAL",
      message,
    };
  }

  for (const code of details.codes) {
    if (RETRYABLE_SESSION_START_CODES.has(code)) {
      return {
        kind: "retryable-session-start",
        retryable: true,
        category: "session-start",
        code,
        message,
      };
    }
  }

  if (RETRYABLE_SESSION_START_PATTERN.test(details.text)) {
    return {
      kind: "retryable-session-start",
      retryable: true,
      category: "session-start",
      code: [...details.codes][0] ?? "ESESSIONSTART",
      message,
    };
  }

  return {
    kind: "fatal",
    retryable: false,
    category: "unknown",
    code: [...details.codes][0] ?? "UNKNOWN",
    message,
  };
}

export function isRetryableSwarmLaunchFailure(error: unknown): boolean {
  return classifySwarmLaunchFailure(error).retryable;
}
