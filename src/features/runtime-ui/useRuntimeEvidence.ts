import type { RuntimeUiEvidenceEntry, RuntimeUiInstance } from "@common/runtime-ui";
import { useEffect, useState } from "react";

interface EvidenceState {
  readonly scopeKey: string;
  readonly entries: readonly RuntimeUiEvidenceEntry[];
  readonly error?: string;
}
/** Entries come from the extension's durable store, independently of open panels. */
export function useRuntimeEvidence(sessionId: string | null, workspaceName: string | undefined) {
  const scopeKey = JSON.stringify([sessionId, workspaceName]);
  const [state, setState] = useState<EvidenceState>({ scopeKey, entries: [] });
  useEffect(() => {
    const api = window.runtimeUiAPI;
    if (!sessionId || !workspaceName || !api?.getEvidence) return undefined;
    let active = true;
    let revision = 0;
    const refresh = async () => {
      const requested = ++revision;
      try {
        const result = await api.getEvidence!({ sessionId, workspaceName });
        if (!active || requested !== revision) return;
        if (result.success) setState({ scopeKey, entries: result.value });
        else
          setState((current) => ({
            scopeKey,
            entries: current.scopeKey === scopeKey ? current.entries : [],
            error: result.error.message,
          }));
      } catch (failure) {
        if (active && requested === revision)
          setState((current) => ({
            scopeKey,
            entries: current.scopeKey === scopeKey ? current.entries : [],
            error: String(failure),
          }));
      }
    };
    void refresh();
    const unsubscribe = api.onEvent((event) => {
      if (event.scope.sessionId === sessionId && event.scope.workspaceName === workspaceName)
        void refresh();
    });
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [sessionId, workspaceName, scopeKey]);
  const open = async (
    entry: RuntimeUiEvidenceEntry,
    presentation?: "embedded",
  ): Promise<RuntimeUiInstance | undefined> => {
    try {
      const result = await window.runtimeUiAPI?.openEvidence?.({
        ...entry,
        ...(presentation ? { presentation } : {}),
        idempotencyKey: `evidence-open:${entry.id}:${crypto.randomUUID()}`,
      });
      if (result?.success)
        return (
          result.value.instance ??
          result.value.instances?.find(
            (instance) =>
              instance.content.kind === "application" &&
              instance.content.state?.run &&
              typeof instance.content.state.run === "object" &&
              !Array.isArray(instance.content.state.run) &&
              "runId" in instance.content.state.run &&
              instance.content.state.run.runId === entry.id,
          )
        );
      if (result && !result.success)
        setState((current) =>
          current.scopeKey === scopeKey ? { ...current, error: result.error.message } : current,
        );
    } catch (failure) {
      setState((current) =>
        current.scopeKey === scopeKey ? { ...current, error: String(failure) } : current,
      );
    }
    return undefined;
  };
  return {
    entries: state.scopeKey === scopeKey ? state.entries : [],
    error: state.scopeKey === scopeKey ? state.error : undefined,
    open,
  };
}
