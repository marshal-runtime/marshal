import "@marshal/agentic-debugger-extension/ui/styles.css";
import type { RuntimeUiJsonValue } from "@common/runtime-ui";
import {
  DebuggerRuntimeUi,
  type DebuggerBridgeAdapter,
  type DebuggerCommand,
  type DebuggerEditor,
  type DebuggerPanelScope,
  type DebuggerPanelViewState,
  type DebuggerSnapshot,
  type DebuggerSourceFile,
  type RuntimeDebuggerUiState,
} from "@marshal/agentic-debugger-extension/ui";

import type { MarshalRuntimeEditor } from "./RuntimeEditor";
import type {
  RuntimeUiApplicationRenderer,
  RuntimeUiApplicationRenderHost,
} from "./RuntimeUiApplicationRegistry";

const DEBUGGER_RENDER_ID = "marshal.agentic-debugger.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function stateValue(
  instanceState: Readonly<Record<string, RuntimeUiJsonValue>> | undefined,
  key: string,
): string {
  return text(instanceState?.[key], `Debugger UI state ${key}`);
}

function debuggerScope(state: Readonly<Record<string, RuntimeUiJsonValue>>): DebuggerPanelScope {
  return {
    chatId: stateValue(state, "chatId"),
    sessionId: stateValue(state, "debuggerSessionId"),
    runtimeSessionId: stateValue(state, "runtimeSessionId"),
    executionBlockId: stateValue(state, "executionBlockId"),
    scopeKey: stateValue(state, "scopeKey"),
    workspaceName: typeof state.workspaceName === "string" ? state.workspaceName : undefined,
  };
}

function unwrapBridgeOutput(output: unknown): unknown {
  return record(output, "Debugger capability output")["value"];
}

function snapshotFromOutput(output: unknown): DebuggerSnapshot {
  const value = record(unwrapBridgeOutput(output), "Debugger bridge value")["snapshot"];
  if (!isDebuggerSnapshot(value)) throw new Error("Debugger snapshot has an invalid shape.");
  return value;
}

function sourceFromOutput(output: unknown): DebuggerSourceFile {
  const value = unwrapBridgeOutput(output);
  if (!isDebuggerSourceFile(value)) throw new Error("Debugger source has an invalid shape.");
  return value;
}

function isDebuggerSnapshot(value: unknown): value is DebuggerSnapshot {
  if (!isRecord(value)) return false;
  return (
    (value["state"] === "paused" ||
      value["state"] === "running" ||
      value["state"] === "completed") &&
    Array.isArray(value["sources"]) &&
    Array.isArray(value["breakpoints"]) &&
    Array.isArray(value["callStack"]) &&
    Array.isArray(value["locals"]) &&
    Array.isArray(value["watches"]) &&
    Array.isArray(value["console"]) &&
    Array.isArray(value["events"])
  );
}

function isDebuggerSourceFile(value: unknown): value is DebuggerSourceFile {
  return (
    isRecord(value) && typeof value["path"] === "string" && typeof value["language"] === "string"
  );
}

function breakpointById(snapshot: DebuggerSnapshot, breakpointId: string) {
  const breakpoint = snapshot.breakpoints.find((candidate) => candidate.id === breakpointId);
  if (!breakpoint) throw new Error(`Breakpoint not found: ${breakpointId}`);
  return breakpoint;
}

function debuggerEditorFromRuntimeEditor(editor: MarshalRuntimeEditor): DebuggerEditor {
  return {
    id: editor.id,
    SourceEditor: ({ source, breakpoints, currentLine, theme, onToggleBreakpoint }) => (
      <editor.SourceEditor
        source={source}
        breakpoints={breakpoints.map(({ line, enabled, origin }) => ({
          line,
          enabled,
          origin,
        }))}
        currentLine={currentLine}
        theme={theme}
        onToggleBreakpoint={onToggleBreakpoint}
      />
    ),
  };
}

function createDebuggerAdapter(
  host: RuntimeUiApplicationRenderHost,
  scope: DebuggerPanelScope,
): DebuggerBridgeAdapter {
  let latestSnapshot: DebuggerSnapshot | undefined;
  const panelState = new Map<string, DebuggerPanelViewState>();

  const getSnapshot = async (): Promise<DebuggerSnapshot> => {
    const result = await host.invokeCapability({
      capability: "debug.session.get",
      input: { sessionId: scope.sessionId },
      idempotencyKey: `debugger-ui:get:${host.instance.instanceId}:${Date.now()}`,
    });
    latestSnapshot = snapshotFromOutput(result.output);
    return latestSnapshot;
  };

  const invoke = async (
    capability: string,
    input: Readonly<Record<string, unknown>> = {},
  ): Promise<void> => {
    await host.invokeCapability({
      capability,
      input: { sessionId: scope.sessionId, ...input },
      idempotencyKey: `debugger-ui:${capability}:${host.instance.instanceId}:${Date.now()}`,
    });
    await getSnapshot();
  };

  const dispatch = async (_scope: DebuggerPanelScope, command: DebuggerCommand): Promise<void> => {
    const snapshot = latestSnapshot ?? (await getSnapshot());
    switch (command.type) {
      case "continue":
        return invoke("debug.execution.continue", { threadId: command.threadId });
      case "pause":
        return invoke("debug.execution.pause", { threadId: command.threadId });
      case "step-over":
        return invoke("debug.execution.stepOver", { threadId: command.threadId });
      case "step-into":
        return invoke("debug.execution.stepInto", { threadId: command.threadId });
      case "step-out":
        return invoke("debug.execution.stepOut", { threadId: command.threadId });
      case "select-frame":
        latestSnapshot = { ...snapshot, selectedFrameId: command.frameId };
        return;
      case "set-breakpoint":
        return invoke("debug.breakpoint.set", {
          file: command.file,
          line: command.line,
          origin: command.origin,
        });
      case "toggle-breakpoint": {
        const breakpoint = breakpointById(snapshot, command.breakpointId);
        return invoke(command.enabled ? "debug.breakpoint.enable" : "debug.breakpoint.disable", {
          breakpointId: breakpoint.id,
          file: breakpoint.file,
          line: breakpoint.line,
        });
      }
      case "update-breakpoint": {
        const breakpoint = breakpointById(snapshot, command.breakpointId);
        return invoke("debug.breakpoint.set", {
          file: breakpoint.file,
          line: breakpoint.line,
          condition: command.condition,
          origin: breakpoint.origin,
        });
      }
      case "remove-breakpoint": {
        const breakpoint = breakpointById(snapshot, command.breakpointId);
        return invoke("debug.breakpoint.remove", {
          breakpointId: breakpoint.id,
          file: breakpoint.file,
          line: breakpoint.line,
        });
      }
      case "add-watch":
        return invoke("debug.watch.manage", {
          action: "add",
          expression: command.expression,
          frameId: command.frameId,
          origin: command.origin,
        });
      case "remove-watch": {
        const watch = snapshot.watches.find((candidate) => candidate.id === command.watchId);
        if (!watch) throw new Error(`Watch not found: ${command.watchId}`);
        return invoke("debug.watch.manage", {
          action: "remove",
          watchId: command.watchId,
          expression: watch.expression,
        });
      }
      case "evaluate":
        return invoke("debug.inspect.evaluate", {
          expression: command.expression,
          frameId: command.frameId,
          context: "repl",
          origin: command.origin,
        });
    }
  };

  return {
    getSnapshot,
    async readSource(_scope, path) {
      const result = await host.invokeCapability({
        capability: "debug.source.read",
        input: { sessionId: scope.sessionId, path },
        idempotencyKey: `debugger-ui:source:${host.instance.instanceId}:${path}:${Date.now()}`,
      });
      return sourceFromOutput(result.output);
    },
    dispatch,
    subscribe(_scope, listener) {
      return host.subscribe((event) => {
        if (
          event.scope.sessionId !== host.instance.owner.sessionId ||
          (event.type !== "instance-updated" && event.type !== "instance-focused")
        ) {
          return;
        }
        void getSnapshot()
          .then(listener)
          .catch(() => undefined);
      });
    },
    async loadPanelState() {
      return panelState.get(scope.scopeKey ?? scope.sessionId) ?? null;
    },
    async savePanelState(_scope, state) {
      panelState.set(scope.scopeKey ?? scope.sessionId, state);
    },
  };
}

// oxlint-disable-next-line react/only-export-components
export const agenticDebuggerRuntimeUiRenderer: RuntimeUiApplicationRenderer = ({
  instance,
  host,
}) => {
  if (instance.content.kind !== "application" || instance.content.renderId !== DEBUGGER_RENDER_ID) {
    return null;
  }
  const state = instance.content.state;
  if (!state) {
    return <p className="p-4 text-sm text-destructive">Debugger state is unavailable.</p>;
  }
  const scope = debuggerScope(state);
  const debuggerState: RuntimeDebuggerUiState = {
    chatId: scope.chatId,
    runtimeSessionId: scope.runtimeSessionId ?? "",
    debuggerSessionId: scope.sessionId,
    executionBlockId: scope.executionBlockId,
    scopeKey: scope.scopeKey ?? "",
    ...(scope.workspaceName ? { workspaceName: scope.workspaceName } : {}),
  };
  const adapter = createDebuggerAdapter(host, scope);
  const editor = debuggerEditorFromRuntimeEditor(host.editor);
  return (
    <div className="min-h-0 flex-1" data-testid="marshal-debugger-panel">
      <DebuggerRuntimeUi state={debuggerState} adapter={adapter} editor={editor} theme="light" />
    </div>
  );
};

export { DEBUGGER_RENDER_ID };
