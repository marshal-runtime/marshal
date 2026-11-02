import {
  MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
  runtimeUiScopeKey,
  type RuntimeUiContent,
  type RuntimeUiError,
  type RuntimeUiEvent,
  type RuntimeUiInstance,
  type RuntimeUiScope,
  type RuntimeUiSnapshot,
  type RuntimeUiSurface,
} from "@common/runtime-ui";
import { SWARM_RUN_VIEW_RENDER_ID } from "@marshal/swarm/presentation";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import type { SessionMetadata } from "@/types/electron";

type RuntimeUiStatus = "idle" | "loading" | "ready" | "error" | "unavailable";
type RuntimeUiOperation = "close" | "focus" | "update";

export interface RuntimeUiPendingOperation {
  readonly operation: RuntimeUiOperation;
  readonly token: string;
}

interface RuntimeUiState {
  readonly scopeKey: string | null;
  readonly status: RuntimeUiStatus;
  readonly instances: ReadonlyMap<string, RuntimeUiInstance>;
  readonly revision: number;
  readonly lastSequence: number;
  readonly error: RuntimeUiError | null;
  readonly pending: ReadonlyMap<string, RuntimeUiPendingOperation>;
}

type RuntimeUiStateAction =
  | { readonly type: "reset"; readonly scopeKey: string | null }
  | { readonly type: "snapshot"; readonly scopeKey: string; readonly snapshot: RuntimeUiSnapshot }
  | { readonly type: "event"; readonly scopeKey: string; readonly event: RuntimeUiEvent }
  | { readonly type: "error"; readonly scopeKey: string; readonly error: RuntimeUiError }
  // Distinct from "error": window.runtimeUiAPI itself doesn't exist in this
  // window (e.g. the mobile web client, which has no Electron preload
  // bridge) — a permanent, structural condition for the whole session, not a
  // transient backend failure. Doesn't populate `error`, so it never drives
  // the destructive RuntimeUiErrorNotice alert (whose Reload button would
  // silently no-op anyway, since resync() also requires the bridge).
  | { readonly type: "unavailable"; readonly scopeKey: string }
  | { readonly type: "dismiss-error" }
  | {
      readonly type: "optimistic-focus";
      readonly instanceId: string;
      readonly focusedAt: string;
      readonly surface?: RuntimeUiSurface;
      readonly token: string;
    }
  | {
      readonly type: "optimistic-close";
      readonly instanceId: string;
      readonly token: string;
    }
  | {
      readonly type: "optimistic-update";
      readonly instanceId: string;
      readonly content: RuntimeUiContent;
      readonly token: string;
    }
  | {
      readonly type: "operation-succeeded";
      readonly instanceId: string;
      readonly token: string;
      readonly instance?: RuntimeUiInstance;
    }
  | {
      readonly type: "operation-failed";
      readonly instanceId: string;
      readonly token: string;
      readonly rollback: RuntimeUiInstance;
      readonly error: RuntimeUiError;
    };

const INITIAL_STATE: RuntimeUiState = {
  scopeKey: null,
  status: "idle",
  instances: new Map(),
  revision: 0,
  lastSequence: 0,
  error: null,
  pending: new Map(),
};

function runtimeUiReducer(state: RuntimeUiState, action: RuntimeUiStateAction): RuntimeUiState {
  if ("scopeKey" in action && action.scopeKey !== state.scopeKey && action.type !== "reset") {
    return state;
  }
  switch (action.type) {
    case "reset":
      return {
        ...INITIAL_STATE,
        scopeKey: action.scopeKey,
        status: action.scopeKey ? "loading" : "idle",
      };
    case "snapshot": {
      if (action.snapshot.revision < state.revision) return state;
      const lastSequence = action.snapshot.events.reduce(
        (highest, event) => Math.max(highest, event.sequence),
        action.snapshot.revision,
      );
      return {
        ...state,
        status: "ready",
        instances: new Map(
          action.snapshot.instances.map((instance) => [instance.instanceId, instance]),
        ),
        revision: action.snapshot.revision,
        lastSequence,
        error: null,
        pending: new Map(),
      };
    }
    case "event":
      return applyRuntimeUiEvent(state, action.event);
    case "error":
      return {
        ...state,
        status: state.status === "loading" ? "error" : state.status,
        error: action.error,
      };
    case "unavailable":
      return { ...state, status: "unavailable" };
    case "dismiss-error":
      return { ...state, error: null };
    case "optimistic-focus": {
      const instance = state.instances.get(action.instanceId);
      if (!instance) return state;
      const instances = new Map(state.instances);
      instances.set(action.instanceId, {
        ...instance,
        focusedAt: action.focusedAt,
        ...(action.surface ? { surface: action.surface } : {}),
      });
      return withPending(state, instances, action.instanceId, "focus", action.token);
    }
    case "optimistic-close": {
      if (!state.instances.has(action.instanceId)) return state;
      const instances = new Map(state.instances);
      instances.delete(action.instanceId);
      return withPending(state, instances, action.instanceId, "close", action.token);
    }
    case "optimistic-update": {
      const instance = state.instances.get(action.instanceId);
      if (!instance) return state;
      const instances = new Map(state.instances);
      instances.set(action.instanceId, {
        ...instance,
        content: action.content,
        updatedAt: new Date().toISOString(),
      });
      return withPending(state, instances, action.instanceId, "update", action.token);
    }
    case "operation-succeeded": {
      if (state.pending.get(action.instanceId)?.token !== action.token) return state;
      const instances = new Map(state.instances);
      if (action.instance) {
        const current = instances.get(action.instanceId);
        if (!current || action.instance.revision >= current.revision) {
          instances.set(action.instanceId, action.instance);
        }
      }
      const pending = new Map(state.pending);
      pending.delete(action.instanceId);
      return { ...state, instances, pending, error: null };
    }
    case "operation-failed": {
      if (state.pending.get(action.instanceId)?.token !== action.token) return state;
      const instances = new Map(state.instances);
      instances.set(action.instanceId, action.rollback);
      const pending = new Map(state.pending);
      pending.delete(action.instanceId);
      return { ...state, instances, pending, error: action.error };
    }
  }
  return state;
}

function withPending(
  state: RuntimeUiState,
  instances: ReadonlyMap<string, RuntimeUiInstance>,
  instanceId: string,
  operation: RuntimeUiOperation,
  token: string,
): RuntimeUiState {
  const pending = new Map(state.pending);
  pending.set(instanceId, { operation, token });
  return { ...state, instances, pending, error: null };
}

function applyRuntimeUiEvent(state: RuntimeUiState, event: RuntimeUiEvent): RuntimeUiState {
  if (event.sequence <= state.lastSequence) return state;
  const instances = new Map(state.instances);
  const pending = new Map(state.pending);
  if (
    event.type === "instance-opened" ||
    event.type === "instance-updated" ||
    event.type === "instance-focused"
  ) {
    const current = instances.get(event.instance.instanceId);
    if (!current || event.instance.revision >= current.revision) {
      instances.set(event.instance.instanceId, event.instance);
    }
    pending.delete(event.instance.instanceId);
  } else if (event.type === "instance-closed") {
    instances.delete(event.instanceId);
    pending.delete(event.instanceId);
  } else if (event.type === "owner-invalidated") {
    const closed = new Set(event.closedInstanceIds);
    for (const [instanceId, instance] of instances) {
      if (
        closed.has(instanceId) ||
        (instance.owner.extensionId === event.owner.extensionId &&
          instance.owner.applicationId === event.owner.applicationId)
      ) {
        instances.delete(instanceId);
        pending.delete(instanceId);
      }
    }
  }
  return {
    ...state,
    status: "ready",
    instances,
    pending,
    revision: Math.max(state.revision, event.sequence),
    lastSequence: event.sequence,
    error: null,
  };
}

function scopeKey(scope: RuntimeUiScope): string {
  return runtimeUiScopeKey(scope);
}

// Main tracks one subscription per renderer and scope, not per hook. A second
// consumer of the same scope (the document companion beside a workspace tab)
// must not cancel the chat host's events when it unmounts, or documents opened
// afterwards never reach the evidence panel.
const scopeConsumers = new WeakMap<object, Map<string, number>>();

function retainScope(api: object, key: string): () => boolean {
  let counts = scopeConsumers.get(api);
  if (!counts) {
    counts = new Map();
    scopeConsumers.set(api, counts);
  }
  counts.set(key, (counts.get(key) ?? 0) + 1);
  const consumers = counts;
  return () => {
    const remaining = (consumers.get(key) ?? 1) - 1;
    if (remaining > 0) consumers.set(key, remaining);
    else consumers.delete(key);
    return remaining <= 0;
  };
}

function errorFromUnknown(error: unknown): RuntimeUiError {
  return {
    code: "operation-failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function commandToken(operation: RuntimeUiOperation, instanceId: string): string {
  const unique =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `renderer-${operation}-${instanceId}-${unique}`;
}

function compareFocusedAt(left: RuntimeUiInstance, right: RuntimeUiInstance): number {
  const focusOrder = right.focusedAt.localeCompare(left.focusedAt);
  if (focusOrder !== 0) return focusOrder;
  const updateOrder = right.updatedAt.localeCompare(left.updatedAt);
  return updateOrder !== 0 ? updateOrder : left.instanceId.localeCompare(right.instanceId);
}

export interface RuntimeUiModel {
  readonly scope: RuntimeUiScope | null;
  readonly status: RuntimeUiStatus;
  readonly instances: readonly RuntimeUiInstance[];
  readonly bySurface: Readonly<Record<RuntimeUiSurface, readonly RuntimeUiInstance[]>>;
  readonly error: RuntimeUiError | null;
  readonly pending: ReadonlyMap<string, RuntimeUiPendingOperation>;
  /** Pass a surface to move the instance there while focusing it. */
  readonly focus: (instance: RuntimeUiInstance, surface?: RuntimeUiSurface) => Promise<boolean>;
  readonly close: (instance: RuntimeUiInstance) => Promise<boolean>;
  readonly update: (instance: RuntimeUiInstance, content: RuntimeUiContent) => Promise<boolean>;
  readonly resync: () => Promise<void>;
  readonly dismissError: () => void;
}

export function useRuntimeUi(options: {
  readonly activeSessionId: string | null;
  readonly sessions: readonly SessionMetadata[];
}): RuntimeUiModel {
  const activeSession = options.sessions.find((session) => session.id === options.activeSessionId);
  const workspaceName = activeSession
    ? activeSession.workspaceName?.trim() || MARSHAL_RUNTIME_DEFAULT_WORKSPACE
    : null;
  const scope = useMemo<RuntimeUiScope | null>(
    () =>
      options.activeSessionId && workspaceName
        ? { sessionId: options.activeSessionId, workspaceName }
        : null,
    [options.activeSessionId, workspaceName],
  );
  return useRuntimeUiScope(scope);
}

export function useRuntimeUiScope(scope: RuntimeUiScope | null): RuntimeUiModel {
  const currentScopeKey = scope ? scopeKey(scope) : null;
  const [state, dispatch] = useReducer(runtimeUiReducer, INITIAL_STATE);
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const applySnapshot = useCallback(
    (snapshot: RuntimeUiSnapshot) => {
      if (!scope || scopeKey(snapshot.scope) !== currentScopeKey) return;
      dispatch({ type: "snapshot", scopeKey: currentScopeKey, snapshot });
    },
    [currentScopeKey, scope],
  );

  const resync = useCallback(async () => {
    const api = window.runtimeUiAPI;
    const currentScope = scopeRef.current;
    if (!api || !currentScope) return;
    const requestedScopeKey = scopeKey(currentScope);
    try {
      const result = await api.getSnapshot(currentScope);
      if (!scopeRef.current || scopeKey(scopeRef.current) !== requestedScopeKey) return;
      if (result.success) {
        applySnapshot(result.value);
      } else {
        dispatch({ type: "error", scopeKey: requestedScopeKey, error: result.error });
      }
    } catch (error) {
      dispatch({ type: "error", scopeKey: requestedScopeKey, error: errorFromUnknown(error) });
    }
  }, [applySnapshot]);

  useEffect(() => {
    dispatch({ type: "reset", scopeKey: currentScopeKey });
    const api = window.runtimeUiAPI;
    if (!scope || !currentScopeKey) return undefined;
    if (!api) {
      dispatch({ type: "unavailable", scopeKey: currentScopeKey });
      return undefined;
    }
    let active = true;
    const releaseScope = retainScope(api, currentScopeKey);
    const unsubscribeEvents = api.onEvent((event) => {
      if (!active || scopeKey(event.scope) !== currentScopeKey) return;
      dispatch({ type: "event", scopeKey: currentScopeKey, event });
    });
    const sync = async () => {
      try {
        const initial = await api.getSnapshot(scope);
        if (!active) return;
        if (initial.success) {
          dispatch({ type: "snapshot", scopeKey: currentScopeKey, snapshot: initial.value });
        } else {
          dispatch({ type: "error", scopeKey: currentScopeKey, error: initial.error });
        }
        const subscribed = await api.subscribe(scope);
        if (!active) return;
        if (subscribed.success) {
          dispatch({ type: "snapshot", scopeKey: currentScopeKey, snapshot: subscribed.value });
        } else {
          dispatch({ type: "error", scopeKey: currentScopeKey, error: subscribed.error });
        }
      } catch (error) {
        if (active) {
          dispatch({ type: "error", scopeKey: currentScopeKey, error: errorFromUnknown(error) });
        }
      }
    };
    const resyncWhenVisible = () => {
      if (document.visibilityState === "visible") void resync();
    };
    void sync();
    window.addEventListener("online", resync);
    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", resyncWhenVisible);
    return () => {
      active = false;
      unsubscribeEvents();
      window.removeEventListener("online", resync);
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", resyncWhenVisible);
      if (releaseScope()) void api.unsubscribe(scope);
    };
  }, [currentScopeKey, resync, scope]);

  const focus = useCallback(async (instance: RuntimeUiInstance, surface?: RuntimeUiSurface) => {
    const api = window.runtimeUiAPI;
    if (!api) return false;
    const token = commandToken("focus", instance.instanceId);
    dispatch({
      type: "optimistic-focus",
      instanceId: instance.instanceId,
      focusedAt: new Date().toISOString(),
      ...(surface ? { surface } : {}),
      token,
    });
    try {
      const result = await api.focus({
        ...instance.owner,
        instanceId: instance.instanceId,
        idempotencyKey: token,
        ...(surface ? { surface } : {}),
      });
      if (!result.success) {
        dispatch({
          type: "operation-failed",
          instanceId: instance.instanceId,
          token,
          rollback: instance,
          error: result.error,
        });
        return false;
      }
      dispatch({
        type: "operation-succeeded",
        instanceId: instance.instanceId,
        token,
        instance: result.value.instance,
      });
      return true;
    } catch (error) {
      dispatch({
        type: "operation-failed",
        instanceId: instance.instanceId,
        token,
        rollback: instance,
        error: errorFromUnknown(error),
      });
      return false;
    }
  }, []);

  const close = useCallback(async (instance: RuntimeUiInstance) => {
    const api = window.runtimeUiAPI;
    if (!api) return false;
    const token = commandToken("close", instance.instanceId);
    dispatch({ type: "optimistic-close", instanceId: instance.instanceId, token });
    try {
      const result = await api.close({
        ...instance.owner,
        instanceId: instance.instanceId,
        idempotencyKey: token,
      });
      if (!result.success) {
        dispatch({
          type: "operation-failed",
          instanceId: instance.instanceId,
          token,
          rollback: instance,
          error: result.error,
        });
        return false;
      }
      dispatch({ type: "operation-succeeded", instanceId: instance.instanceId, token });
      return true;
    } catch (error) {
      dispatch({
        type: "operation-failed",
        instanceId: instance.instanceId,
        token,
        rollback: instance,
        error: errorFromUnknown(error),
      });
      return false;
    }
  }, []);

  const update = useCallback(async (instance: RuntimeUiInstance, content: RuntimeUiContent) => {
    const api = window.runtimeUiAPI;
    if (!api) return false;
    const token = commandToken("update", instance.instanceId);
    dispatch({
      type: "optimistic-update",
      instanceId: instance.instanceId,
      content,
      token,
    });
    try {
      const result = await api.update({
        ...instance.owner,
        instanceId: instance.instanceId,
        content,
        idempotencyKey: token,
      });
      if (!result.success) {
        dispatch({
          type: "operation-failed",
          instanceId: instance.instanceId,
          token,
          rollback: instance,
          error: result.error,
        });
        return false;
      }
      dispatch({
        type: "operation-succeeded",
        instanceId: instance.instanceId,
        token,
        instance: result.value.instance,
      });
      return true;
    } catch (error) {
      dispatch({
        type: "operation-failed",
        instanceId: instance.instanceId,
        token,
        rollback: instance,
        error: errorFromUnknown(error),
      });
      return false;
    }
  }, []);

  const instances = useMemo(
    () => [...state.instances.values()].sort(compareFocusedAt),
    [state.instances],
  );
  // Swarm runs live in the Progress panel. Keep registered instances for host
  // callbacks and events, but never allocate an additional runtime surface.
  const surfaceInstances = useMemo(
    () =>
      instances.filter(
        (instance) =>
          instance.content.kind !== "application" ||
          instance.content.renderId !== SWARM_RUN_VIEW_RENDER_ID,
      ),
    [instances],
  );
  const bySurface = useMemo<RuntimeUiModel["bySurface"]>(
    () => ({
      "inline-card": surfaceInstances.filter((instance) => instance.surface === "inline-card"),
      fullscreen: surfaceInstances.filter((instance) => instance.surface === "fullscreen"),
      tab: surfaceInstances.filter((instance) => instance.surface === "tab"),
      panel: surfaceInstances.filter((instance) => instance.surface === "panel"),
      "bottom-panel": surfaceInstances.filter((instance) => instance.surface === "bottom-panel"),
      floating: surfaceInstances.filter((instance) => instance.surface === "floating"),
    }),
    [surfaceInstances],
  );

  return {
    scope,
    status: state.status,
    instances,
    bySurface,
    error: state.error,
    pending: state.pending,
    focus,
    close,
    update,
    resync,
    dismissError: useCallback(() => dispatch({ type: "dismiss-error" }), []),
  };
}
