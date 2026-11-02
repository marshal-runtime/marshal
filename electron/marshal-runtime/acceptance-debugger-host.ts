import { type DebuggerHostAdapter } from "@marshal/agentic-debugger-extension";

interface AcceptanceDebuggerScope {
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly chatId: string;
  readonly executionBlockId: string;
  readonly workspaceName?: string;
}

interface AcceptanceDebuggerInvocation {
  readonly capability: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly scope: AcceptanceDebuggerScope;
}

interface AcceptanceDebuggerSource {
  readonly path: string;
  readonly name: string;
  readonly language: string;
}

interface AcceptanceDebuggerBreakpoint {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly enabled: boolean;
  readonly verified: boolean;
  readonly origin: "agent" | "human";
  readonly condition?: string;
}

interface AcceptanceDebuggerSnapshot {
  readonly state: "paused" | "running" | "completed";
  readonly statusMessage: string;
  readonly sources: readonly AcceptanceDebuggerSource[];
  readonly activeSourcePath: string;
  readonly currentLocation: { readonly file: string; readonly line: number };
  readonly currentThreadId: number;
  readonly selectedFrameId: number;
  readonly breakpoints: readonly AcceptanceDebuggerBreakpoint[];
  readonly callStack: readonly {
    readonly id: number;
    readonly name: string;
    readonly source: string;
    readonly line: number;
  }[];
  readonly locals: readonly {
    readonly name: string;
    readonly value: string;
    readonly type: string;
  }[];
  readonly watches: readonly {
    readonly id: string;
    readonly expression: string;
    readonly value?: string;
    readonly type?: string;
    readonly origin: "agent" | "human";
  }[];
  readonly console: readonly {
    readonly id: string;
    readonly expression: string;
    readonly result?: string;
    readonly type?: string;
    readonly origin: "agent" | "human";
    readonly timestamp: string;
  }[];
  readonly events: readonly {
    readonly id: string;
    readonly category: "debugger" | "stdout" | "stderr" | "telemetry";
    readonly message: string;
    readonly timestamp: string;
  }[];
}

interface AcceptanceDebuggerHostEvent {
  readonly sessionId: string;
  readonly type: "stopped" | "continued" | "completed";
  readonly occurredAt: string;
  readonly snapshot: AcceptanceDebuggerSnapshot;
}

interface AcceptanceDebuggerSession {
  readonly scope: AcceptanceDebuggerScope;
  snapshot: AcceptanceDebuggerSnapshot;
  readonly listeners: Set<(event: AcceptanceDebuggerHostEvent) => void>;
}

interface AcceptanceDebuggerHostAdapter {
  invoke(invocation: AcceptanceDebuggerInvocation): Promise<unknown>;
  readSource(
    _scope: AcceptanceDebuggerScope,
    debuggerSessionId: string,
    path: string,
  ): Promise<AcceptanceDebuggerSource & { readonly content: string }>;
  subscribe(
    _scope: AcceptanceDebuggerScope,
    debuggerSessionId: string,
    listener: (event: AcceptanceDebuggerHostEvent) => void,
  ): () => void;
  disposeScope(scopeKey: string): Promise<void>;
}

const FIXTURE_PATH = "Q:\\fixture\\app.ts";
const FIXTURE_CONTENT = "const answer = 42;\nconsole.log(answer);";

function now(): string {
  return new Date().toISOString();
}

function text(input: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sessionId(input: Readonly<Record<string, unknown>>): string {
  const value = text(input, "sessionId");
  if (!value) throw new Error("Acceptance debugger input requires sessionId.");
  return value;
}

function initialSnapshot(): AcceptanceDebuggerSnapshot {
  return {
    state: "paused",
    statusMessage: "Paused on entry",
    sources: [{ path: FIXTURE_PATH, name: "app.ts", language: "typescript" }],
    activeSourcePath: FIXTURE_PATH,
    currentLocation: { file: FIXTURE_PATH, line: 1 },
    currentThreadId: 7,
    selectedFrameId: 11,
    breakpoints: [],
    callStack: [{ id: 11, name: "main", source: FIXTURE_PATH, line: 1 }],
    locals: [{ name: "answer", value: "42", type: "number" }],
    watches: [],
    console: [],
    events: [],
  };
}

function updateSnapshot(
  current: AcceptanceDebuggerSnapshot,
  patch: Partial<AcceptanceDebuggerSnapshot>,
): AcceptanceDebuggerSnapshot {
  return { ...current, ...patch };
}

function inputOrigin(input: Readonly<Record<string, unknown>>): "agent" | "human" {
  return input["origin"] === "human" ? "human" : "agent";
}

class AcceptanceDebuggerHost implements AcceptanceDebuggerHostAdapter {
  private readonly sessions = new Map<string, AcceptanceDebuggerSession>();
  private sequence = 0;

  async invoke(invocation: AcceptanceDebuggerInvocation): Promise<unknown> {
    if (
      invocation.capability === "debug.session.launch" ||
      invocation.capability === "debug.session.attach"
    ) {
      const debuggerSessionId = `acceptance-debug-${++this.sequence}`;
      const session: AcceptanceDebuggerSession = {
        scope: invocation.scope,
        snapshot: initialSnapshot(),
        listeners: new Set(),
      };
      this.sessions.set(debuggerSessionId, session);
      return { sessionId: debuggerSessionId, snapshot: session.snapshot };
    }
    if (invocation.capability === "debug.adapter.list") {
      return { adapters: [{ type: "js-debug", languages: ["typescript"] }] };
    }

    const debuggerSessionId = sessionId(invocation.input);
    const session = this.sessions.get(debuggerSessionId);
    if (!session) throw new Error(`Acceptance debugger session not found: ${debuggerSessionId}`);

    const current = session.snapshot;
    let next = current;
    let operationOutput: Record<string, unknown> | undefined;
    let eventType: AcceptanceDebuggerHostEvent["type"] = "stopped";
    switch (invocation.capability) {
      case "debug.execution.continue":
        next = updateSnapshot(current, { state: "running", statusMessage: "Running" });
        eventType = "continued";
        operationOutput = {
          sessionId: debuggerSessionId,
          threadId: Number(invocation.input["threadId"] ?? current.currentThreadId),
          action: invocation.capability,
          snapshot: next,
        };
        break;
      case "debug.execution.pause":
        next = updateSnapshot(current, { state: "paused", statusMessage: "Paused" });
        operationOutput = {
          sessionId: debuggerSessionId,
          threadId: Number(invocation.input["threadId"] ?? current.currentThreadId),
          action: invocation.capability,
          snapshot: next,
        };
        break;
      case "debug.execution.stepOver":
      case "debug.execution.stepInto":
      case "debug.execution.stepOut": {
        const line = current.currentLocation.line + 1;
        next = updateSnapshot(current, {
          state: "paused",
          statusMessage: "Paused after step",
          currentLocation: { file: FIXTURE_PATH, line },
          callStack: [{ id: 11, name: "main", source: FIXTURE_PATH, line }],
        });
        operationOutput = {
          sessionId: debuggerSessionId,
          threadId: Number(invocation.input["threadId"] ?? current.currentThreadId),
          action: invocation.capability,
          snapshot: next,
        };
        break;
      }
      case "debug.session.disconnect":
      case "debug.session.terminate":
        next = updateSnapshot(current, { state: "completed", statusMessage: "Completed" });
        eventType = "completed";
        operationOutput = {
          sessionId: debuggerSessionId,
          [invocation.capability.endsWith("disconnect") ? "disconnected" : "terminated"]: true,
          snapshot: next,
        };
        break;
      case "debug.breakpoint.set": {
        const file = text(invocation.input, "file") ?? FIXTURE_PATH;
        const line = Number(invocation.input["line"] ?? 1);
        const breakpoint: AcceptanceDebuggerBreakpoint = {
          id: `bp-${++this.sequence}`,
          file,
          line,
          enabled: true,
          verified: true,
          origin: inputOrigin(invocation.input),
          ...(text(invocation.input, "condition")
            ? { condition: text(invocation.input, "condition") }
            : {}),
        };
        next = updateSnapshot(current, { breakpoints: [...current.breakpoints, breakpoint] });
        operationOutput = { sessionId: debuggerSessionId, breakpoint, snapshot: next };
        break;
      }
      case "debug.breakpoint.enable":
      case "debug.breakpoint.disable": {
        const breakpointId = text(invocation.input, "breakpointId");
        const enabled = invocation.capability.endsWith("enable");
        const breakpoint = current.breakpoints.find((candidate) => candidate.id === breakpointId);
        if (!breakpoint) throw new Error(`Acceptance breakpoint not found: ${breakpointId}`);
        const updatedBreakpoint = { ...breakpoint, enabled };
        next = updateSnapshot(current, {
          breakpoints: current.breakpoints.map((candidate) =>
            candidate.id === breakpointId ? updatedBreakpoint : candidate,
          ),
        });
        operationOutput = {
          sessionId: debuggerSessionId,
          breakpoint: updatedBreakpoint,
          snapshot: next,
        };
        break;
      }
      case "debug.breakpoint.remove": {
        const breakpointId = text(invocation.input, "breakpointId");
        next = updateSnapshot(current, {
          breakpoints: current.breakpoints.filter((breakpoint) => breakpoint.id !== breakpointId),
        });
        operationOutput = { sessionId: debuggerSessionId, removed: breakpointId, snapshot: next };
        break;
      }
      case "debug.inspect.evaluate": {
        const expression = text(invocation.input, "expression") ?? "answer";
        next = updateSnapshot(current, {
          console: [
            ...current.console,
            {
              id: `console-${++this.sequence}`,
              expression,
              result: expression === "answer" ? "42" : "acceptance-result",
              type: "number",
              origin: inputOrigin(invocation.input),
              timestamp: now(),
            },
          ],
        });
        operationOutput = {
          sessionId: debuggerSessionId,
          result: expression === "answer" ? "42" : "acceptance-result",
          variablesReference: 0,
          snapshot: next,
        };
        break;
      }
      case "debug.watch.manage": {
        const action = text(invocation.input, "action");
        const expression = text(invocation.input, "expression");
        if (action === "add" && expression) {
          next = updateSnapshot(current, {
            watches: [
              ...current.watches,
              {
                id: `watch-${++this.sequence}`,
                expression,
                value: expression === "answer" ? "42" : "acceptance-result",
                type: "number",
                origin: inputOrigin(invocation.input),
              },
            ],
          });
        }
        operationOutput = {
          sessionId: debuggerSessionId,
          action: action === "remove" ? "remove" : action === "evaluate" ? "evaluate" : "add",
          watches: next.watches,
          snapshot: next,
        };
        break;
      }
      default:
        break;
    }

    session.snapshot = next;
    if (next !== current) this.emit(debuggerSessionId, session, eventType);
    return operationOutput ?? { sessionId: debuggerSessionId, snapshot: next };
  }

  async readSource(
    _scope: AcceptanceDebuggerScope,
    debuggerSessionId: string,
    path: string,
  ): Promise<AcceptanceDebuggerSource & { readonly content: string }> {
    if (!this.sessions.has(debuggerSessionId) || path !== FIXTURE_PATH) {
      throw new Error(`Acceptance debugger source not found: ${path}`);
    }
    return { path: FIXTURE_PATH, name: "app.ts", language: "typescript", content: FIXTURE_CONTENT };
  }

  subscribe(
    _scope: AcceptanceDebuggerScope,
    debuggerSessionId: string,
    listener: (event: AcceptanceDebuggerHostEvent) => void,
  ): () => void {
    const session = this.sessions.get(debuggerSessionId);
    if (!session) throw new Error(`Acceptance debugger session not found: ${debuggerSessionId}`);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  async disposeScope(scopeKey: string): Promise<void> {
    for (const [debuggerSessionId, session] of this.sessions) {
      if (session.scope.scopeKey === scopeKey) this.sessions.delete(debuggerSessionId);
    }
  }

  private emit(
    debuggerSessionId: string,
    session: AcceptanceDebuggerSession,
    type: AcceptanceDebuggerHostEvent["type"],
  ): void {
    const event: AcceptanceDebuggerHostEvent = {
      sessionId: debuggerSessionId,
      type,
      occurredAt: now(),
      snapshot: session.snapshot,
    };
    for (const listener of session.listeners) listener(event);
  }
}

export function createAcceptanceDebuggerHostAdapter(): DebuggerHostAdapter {
  return new AcceptanceDebuggerHost();
}
