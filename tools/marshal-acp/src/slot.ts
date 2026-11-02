import { spawn, type ChildProcess } from "node:child_process";

import type { PermissionRequest } from "./permission-policy.ts";

export type SlotResult = {
  status: "completed" | "failed" | "crashed" | "cancelled";
  sessionId: string | null;
  body: string;
  deniedRequests: PermissionRequest[];
  failureReason?: string;
  /** Why the agent's turn ended (`end_turn`, `max_tokens`, etc.). Captured
   *  from the session/prompt response's `stopReason` field. */
  stopReason?: string;
  /** Output-token count for the orchestrator's turn. Captured from the
   *  session/prompt response's `usage.outputTokens` field when present. */
  usageOutputTokens?: number;
};

export type SlotOpts = {
  spawn: {
    cmd: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    /** Optional metadata forwarded as ACP `session/new` `_meta`. */
    sessionMeta?: Record<string, unknown>;
  };
  /** Prompt sent on a fresh `session/new`. Also used as the fallback when
   *  `resumeSessionId` was set but `session/load` failed — that path can't
   *  reference prior conversation context that no longer exists. */
  prompt: string;
  /** When set, the slot calls ACP `session/load` with this id instead of
   *  `session/new`. Used by the keep-context flow so the resumed iteration
   *  inherits the prior chat. Falls back to a fresh session (using `prompt`)
   *  if load fails. */
  resumeSessionId?: string;
  /** Sent only on a confirmed `session/load`. Typically references prior
   *  conversation context ("compare against earlier findings"). Required
   *  when `resumeSessionId` is set; ignored otherwise. */
  resumePrompt?: string;
  /** When the initial prompt's turn ends without a synthesis section AND
   *  the body shows mid-narration markers, fire one follow-up session/prompt
   *  nudging the agent to synthesize. Default true. Set false in tests or
   *  for adapters that don't dispatch sub-agents. */
  followUpOnTruncation?: boolean;
  isAllowed: (req: PermissionRequest) => boolean;
  onUpdate: (event: { kind: string; payload: unknown }) => void;
  /** Called when the agent returns a session id (after `session/new`). Lets the
   *  caller persist the id mid-run so a hung review can still be resumed. */
  onSessionStarted?: (sessionId: string, childPid: number) => void | Promise<void>;
  signal?: AbortSignal;
  /** Hard ceiling on how long a single slot may run (default 30min). Protects
   *  against zombie children — on Windows a cmd.exe wrapper can outlive the
   *  underlying node process and never emit 'close', leaving the slot held
   *  forever. After the timeout, the slot is killed and returns "failed". */
  maxLifetimeMs?: number;
};

export async function runSlot(opts: SlotOpts): Promise<SlotResult> {
  const child: ChildProcess = spawn(opts.spawn.cmd, opts.spawn.args, {
    cwd: opts.spawn.cwd,
    env: opts.spawn.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const stderrBuf: Buffer[] = [];
  child.stderr?.on("data", (c: Buffer) => stderrBuf.push(c));

  // Spawn-time errors (ENOENT for missing binary, EACCES, etc.) arrive
  // asynchronously via the 'error' event. Without a listener attached they
  // propagate as uncaught and crash the daemon. The real recovery happens
  // in exitPromise's error listener below, which rejects in-flight RPCs.
  child.on("error", () => {
    // Intentionally swallow — exitPromise + rejectAllPending handle this.
  });

  let nextReqId = 1;
  // Pending RPC responses, keyed by request id. Stored as `unknown` resolvers
  // (each rpc() call narrows at its await site) so we don't need a per-call
  // generic cast.
  const pending = new Map<number, (v: unknown) => void>();
  let bodyBuf = "";
  let sessionId: string | null = null;
  const denied: PermissionRequest[] = [];
  let stopReason: string | null = null;
  let outputTokens: number | undefined;

  function send(obj: unknown): void {
    child.stdin?.write(JSON.stringify(obj) + "\n");
  }

  function rpc(method: string, params: unknown): Promise<unknown> {
    const id = nextReqId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  let stdoutBuf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isJsonObject(parsed)) continue;
      const msg = parsed;

      const msgId = typeof msg.id === "number" ? msg.id : undefined;
      const method = typeof msg.method === "string" ? msg.method : undefined;

      if (msgId !== undefined && pending.has(msgId) && method === undefined) {
        pending.get(msgId)!(msg.result ?? msg.error);
        pending.delete(msgId);
        continue;
      }
      if (method === "session/request_permission") {
        // ACP permission request shape:
        //   { sessionId, toolCall: { toolCallId, title, kind, content:[...] }, options: [{ optionId, name, kind }] }
        // The agent's tool intent is captured in toolCall.kind (one of
        // read/edit/delete/move/search/execute/think/fetch/other) and the
        // command string lives inside toolCall.content[].content.text or
        // toolCall.rawInput. Bridge that to our { tool, input.command }
        // predicate.
        const params = isJsonObject(msg.params) ? msg.params : {};
        const toolCall = isJsonObject(params.toolCall) ? params.toolCall : {};
        const acpKind = typeof toolCall.kind === "string" ? toolCall.kind : "other";
        const cmd = extractCommand(toolCall);
        const normalized: PermissionRequest = {
          tool: acpKind === "execute" ? "Bash" : acpKind,
          input: { command: cmd },
        };
        const allowed = opts.isAllowed(normalized);
        if (!allowed) denied.push(normalized);

        // Pick the option matching our verdict from the agent's provided
        // options. Fall back to the first option of the right family if
        // the exact kind isn't offered.
        const wantKind = allowed ? "allow_once" : "reject_once";
        const rawOptions = Array.isArray(params.options) ? params.options : [];
        const options = rawOptions
          .filter(isJsonObject)
          .filter(
            (o): o is { optionId: string; kind: string } =>
              typeof o.optionId === "string" && typeof o.kind === "string",
          );
        const chosen =
          options.find((o) => o.kind === wantKind) ??
          options.find((o) => o.kind.startsWith(allowed ? "allow_" : "reject_"));
        const outcome = chosen
          ? { outcome: "selected", optionId: chosen.optionId }
          : { outcome: "cancelled" };
        send({ jsonrpc: "2.0", id: msgId, result: { outcome } });
        continue;
      }
      if (method === "session/update") {
        // ACP session/update payload uses `sessionUpdate` as the discriminator
        // (NOT `kind` — `kind` is used inside tool_call objects for a different
        // purpose). Verified against @agentclientprotocol/sdk's examples/agent.js.
        const params = isJsonObject(msg.params) ? msg.params : {};
        const u = isJsonObject(params.update) ? params.update : {};
        const sessionUpdate = typeof u.sessionUpdate === "string" ? u.sessionUpdate : "unknown";
        opts.onUpdate({ kind: sessionUpdate, payload: u });
        if (sessionUpdate === "agent_message_chunk") {
          // content can be a single ContentBlock or an array; handle both
          const text = extractText(u.content);
          bodyBuf += text;
        }
        // session/update is a one-way notification — ACK with empty result
        // so the agent's awaiting send doesn't sit forever.
        if (msgId !== undefined) {
          send({ jsonrpc: "2.0", id: msgId, result: {} });
        }
        continue;
      }
    }
  });

  // Reject any in-flight RPC if the child exits before responding. Without
  // this, an early-exiting agent (e.g. auth failure, missing API key, instant
  // crash) leaves `await rpc(...)` hung forever and the slot never frees.
  function rejectAllPending(reason: string): void {
    for (const [id, resolve] of pending) {
      resolve({ __rpcAborted: true, reason });
      pending.delete(id);
    }
  }

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("close", (code, signal) => {
        rejectAllPending(`agent exited before response (code=${code}, signal=${signal})`);
        resolve({ code, signal });
      });
      child.on("error", (err: Error) => {
        rejectAllPending(`agent spawn error: ${err.message}`);
        resolve({ code: null, signal: null });
      });
    },
  );

  if (opts.signal) {
    opts.signal.addEventListener("abort", () => {
      child.kill("SIGTERM");
    });
  }

  const maxLifetimeMs = opts.maxLifetimeMs ?? 30 * 60_000;
  let lifetimeTimedOut = false;
  const lifetimeTimer = setTimeout(() => {
    lifetimeTimedOut = true;
    rejectAllPending(`slot exceeded maxLifetimeMs (${maxLifetimeMs}ms)`);
    // SIGKILL — on Windows zombies don't respond to SIGTERM. The fallback
    // .kill() (default SIGTERM) is a hedge for platforms where the literal
    // is interpreted unusually; harmless if it duplicates the SIGKILL.
    try {
      child.kill("SIGKILL");
    } catch {
      child.kill();
    }
  }, maxLifetimeMs);

  function checkRpcAborted(r: unknown): void {
    if (isJsonObject(r) && r.__rpcAborted === true) {
      const reason = typeof r.reason === "string" ? r.reason : "agent exited before response";
      throw new Error(reason);
    }
  }

  function extractSessionId(r: unknown): string | null {
    if (isJsonObject(r) && typeof r.sessionId === "string") return r.sessionId;
    return null;
  }
  function extractStopReason(r: unknown): string | null {
    if (isJsonObject(r) && typeof r.stopReason === "string") return r.stopReason;
    return null;
  }
  function extractOutputTokens(r: unknown): number | undefined {
    if (isJsonObject(r) && isJsonObject(r.usage) && typeof r.usage.outputTokens === "number") {
      return r.usage.outputTokens;
    }
    return undefined;
  }

  try {
    const initResp = await rpc("initialize", { protocolVersion: 1 });
    checkRpcAborted(initResp);

    // ACP requires `mcpServers: []` even when empty — claude-agent-acp rejects
    // with "Invalid params" otherwise. The shape matches the SDK test fixtures
    // at @agentclientprotocol/sdk/dist/acp.test.js:416.
    const newSessionParams = {
      cwd: opts.spawn.cwd,
      mcpServers: [],
      // Forward adapter-specific metadata (e.g. Claude's managedSettings policy
      // deny-list). Goes through as `params._meta` so the ACP server can route
      // it into the underlying agent SDK.
      ...(opts.spawn.sessionMeta ? { _meta: opts.spawn.sessionMeta } : {}),
    };

    let resumed = false;
    if (opts.resumeSessionId) {
      // Try session/load first. If it returns an error, fall back to a fresh
      // session — this lets us ship the feature without taking a hard
      // dependency on claude-agent-acp's session/load support, which is
      // best-effort at the time of writing.
      const loadResp = await rpc("session/load", {
        sessionId: opts.resumeSessionId,
        cwd: opts.spawn.cwd,
        mcpServers: [],
      });
      checkRpcAborted(loadResp);
      const loaded =
        isJsonObject(loadResp) && !("code" in loadResp) && !("__rpcAborted" in loadResp);
      if (loaded) {
        sessionId = opts.resumeSessionId;
        resumed = true;
        // session/load may replay prior turn content via session/update
        // notifications; the model needs that for context but we don't want
        // it in this iteration's review markdown. Reset so the body captures
        // only what the agent emits in response to the new prompt.
        bodyBuf = "";
      } else {
        process.stderr.write(
          `[review-queue] session/load failed for ${opts.resumeSessionId}; falling back to fresh session\n`,
        );
        const sessionResp = await rpc("session/new", newSessionParams);
        checkRpcAborted(sessionResp);
        sessionId = extractSessionId(sessionResp);
      }
    } else {
      const sessionResp = await rpc("session/new", newSessionParams);
      checkRpcAborted(sessionResp);
      sessionId = extractSessionId(sessionResp);
    }
    if (sessionId && opts.onSessionStarted) {
      await opts.onSessionStarted(sessionId, child.pid ?? 0);
    }

    // Pick the resume-aware prompt only on a confirmed session/load.
    // Falling-back to session/new with a prompt that says "compare against
    // our prior conversation" would confuse the agent — there IS no prior
    // conversation in a fresh session.
    const promptText = resumed && opts.resumePrompt ? opts.resumePrompt : opts.prompt;

    // ACP session/prompt request uses field name `prompt` (not `content`) per
    // zPromptRequest in @agentclientprotocol/sdk's generated zod schema.
    const promptResp = await rpc("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
    });
    checkRpcAborted(promptResp);
    stopReason = extractStopReason(promptResp);
    const promptTokens = extractOutputTokens(promptResp);
    if (promptTokens !== undefined) outputTokens = promptTokens;

    // Recover truncated reviews: when the orchestrator ends its turn while
    // its narration shows mid-flight sub-agent waits, the synthesis section
    // is missing. Fire one follow-up prompt to nudge it to wrap up.
    // Triggered ONLY when all three hold:
    //   1. opts.followUpOnTruncation is on (default)
    //   2. stopReason is end_turn (agent voluntarily ended)
    //   3. body lacks any synthesis heading AND ends with a "waiting on" /
    //      "N of M" pattern signaling an unfinished orchestration loop
    const wantsFollowUp = opts.followUpOnTruncation !== false;
    if (wantsFollowUp && stopReason === "end_turn" && needsSynthesisFollowUp(bodyBuf)) {
      const followupResp = await rpc("session/prompt", {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Your previous turn ended without a synthesis section. All sub-agents have completed by now. Synthesize their findings into the final review using the format from Step 4 of the marshal-code-review skill: a top-level Summary paragraph, then Findings (🔴 Critical → 🟡 Important → 💡 Suggestion) with file:line references and concrete fixes, then What's good, then Questions. Do not narrate progress — emit the final review directly.",
          },
        ],
      });
      checkRpcAborted(followupResp);
      const followupStop = extractStopReason(followupResp);
      if (followupStop) stopReason = followupStop;
      const followupTokens = extractOutputTokens(followupResp);
      if (followupTokens !== undefined) outputTokens = (outputTokens ?? 0) + followupTokens;
    }
  } catch (err: unknown) {
    clearTimeout(lifetimeTimer);
    child.kill("SIGTERM");
    await Promise.race([exitPromise, new Promise<void>((r) => setTimeout(r, 1000))]);
    return {
      status: "failed",
      sessionId,
      body: bodyBuf,
      deniedRequests: denied,
      failureReason: errMsg(err) || tail(stderrBuf),
    };
  }

  await new Promise<void>((r) => setTimeout(r, 50));
  child.stdin?.end();
  const exit = await exitPromise;
  clearTimeout(lifetimeTimer);

  if (lifetimeTimedOut) {
    return {
      status: "failed",
      sessionId,
      body: bodyBuf,
      deniedRequests: denied,
      failureReason: `slot exceeded maxLifetimeMs (${maxLifetimeMs}ms)`,
      ...(stopReason ? { stopReason } : {}),
      ...(outputTokens !== undefined ? { usageOutputTokens: outputTokens } : {}),
    };
  }
  if (opts.signal?.aborted) {
    return {
      status: "cancelled",
      sessionId,
      body: bodyBuf,
      deniedRequests: denied,
      ...(stopReason ? { stopReason } : {}),
      ...(outputTokens !== undefined ? { usageOutputTokens: outputTokens } : {}),
    };
  }
  if (exit.code === 0 || stopReason === "end_turn") {
    return {
      status: "completed",
      sessionId,
      body: bodyBuf,
      deniedRequests: denied,
      ...(stopReason ? { stopReason } : {}),
      ...(outputTokens !== undefined ? { usageOutputTokens: outputTokens } : {}),
    };
  }
  return {
    status: "failed",
    sessionId,
    body: bodyBuf,
    deniedRequests: denied,
    failureReason: tail(stderrBuf) || `exit ${exit.code}`,
    ...(stopReason ? { stopReason } : {}),
    ...(outputTokens !== undefined ? { usageOutputTokens: outputTokens } : {}),
  };
}

function extractCommand(toolCall: { rawInput?: unknown; content?: unknown }): string {
  // Only treat structured rawInput.command as a real command string. The
  // previous fallback that concatenated toolCall.content (display text for
  // UI dialogs, not the actual command) was misleading defense-in-depth —
  // running our regex denylist against arbitrary prose produced false
  // positives without catching actual shell exec. Empty string falls through
  // to the policy's "no command" branch, which allows the tool call (the
  // real safety is the deny rules on commands we CAN see).
  if (isJsonObject(toolCall.rawInput) && typeof toolCall.rawInput.command === "string") {
    return toolCall.rawInput.command;
  }
  return "";
}

/** Type-guard for plain JSON objects (excludes arrays and primitives). */
function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractText).join("");
  // ACP content block shape after Array/string narrowing; trust-boundary
  // cast on a partial shape we then re-validate with typeof guards below.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const c = content as { type?: string; text?: string; content?: unknown };
  if (c.type === "text" && typeof c.text === "string") return c.text;
  if (c.content !== undefined) return extractText(c.content);
  return "";
}

/** True when the body looks like an marshal-code-review that was cut off mid-orchestration.
 *  Exported for unit tests — see test/follow-up-heuristic.test.ts. */
export function needsSynthesisFollowUp(body: string): boolean {
  // Synthesis headings the skill instructs the orchestrator to emit.
  // case-insensitive, multiline anchor on `## ` so we don't match accidental
  // inline mentions of the word.
  const synthesis = /^##\s+(findings|what['’]s good|review:|summary|recommendation)/im;
  if (synthesis.test(body)) return false;
  // Mid-narration markers — the orchestrator was waiting on sub-agents when
  // the turn ended. Restrict to the trailing window so an early "waiting"
  // mention doesn't trigger a false positive on an otherwise-complete review.
  // Each alternation maps to a narration shape observed in real marshal-code-review
  // runs that ended pre-synthesis:
  //   - "waiting on …" / "… outstanding" / "continuing to wait"
  //   - "N of M complete|done|back" (orchestrator's typical progress line)
  //   - "N of M still running|pending|outstanding" (observed in practice)
  //   - "N agents remaining" / "1 agent remaining" (observed in practice)
  //   - "N to go" (observed in practice)
  const trail = body.slice(-1500);
  const waiting =
    /(waiting on|outstanding|continuing to wait|of\s+\d+\s+(?:complete|done|back|still\s+(?:running|pending|outstanding))|\d+\s+(?:sub-)?agents?\s+remaining|\d+\s+to\s+go)/i;
  return waiting.test(trail);
}

function tail(bufs: Buffer[]): string {
  const all = Buffer.concat(bufs).toString("utf8");
  return all.length > 2048 ? all.slice(-2048) : all;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
