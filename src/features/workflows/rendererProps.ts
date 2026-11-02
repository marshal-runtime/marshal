import type { ArtifactRefSummary, RunHistoryEntry, RunSnapshot } from "@common/workflows-contract";
import type {
  ArtifactRef as SdkArtifactRef,
  WorkflowArtifactContent,
  WorkflowDashboardApi,
  WorkflowRunHistoryEntry,
  WorkflowRunRendererProps,
  WorkflowRunState,
} from "@marshal/workflow-sdk";

interface WorkflowRendererContext {
  readonly runSnapshot: RunSnapshot;
  readonly artifacts: ReadonlyArray<ArtifactRefSummary>;
}

export function adaptWorkflowRendererProps(ctx: WorkflowRendererContext): WorkflowRunRendererProps {
  return {
    run: adaptRunSnapshot(ctx.runSnapshot),
    artifacts: ctx.artifacts.map(adaptArtifactRef),
    dashboard: createDashboardApi(ctx),
  };
}

export function adaptRunSnapshot(snapshot: RunSnapshot): WorkflowRunState {
  return {
    runId: snapshot.runId,
    runFamilyId: snapshot.runFamilyId,
    workflowId: snapshot.workflowId,
    status: mapStatusToSdk(snapshot.status),
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    steps: snapshot.steps.map((step) => ({
      id: step.label,
      stepKey: step.id,
      status: step.status === "skipped-replay" ? "skipped" : step.status,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      error: step.error,
    })),
  };
}

function adaptArtifactRef(artifact: ArtifactRefSummary): SdkArtifactRef {
  return {
    key: artifact.key,
    mime: artifact.mime,
    sizeBytes: artifact.sizeBytes,
    writtenAt: artifact.writtenAt,
    namespace: artifact.namespace,
  };
}

function createDashboardApi(ctx: WorkflowRendererContext): WorkflowDashboardApi {
  const { runSnapshot } = ctx;
  const readArtifact = async (
    keyOrRef: string | SdkArtifactRef,
  ): Promise<WorkflowArtifactContent | null> => {
    const api = window.workflowsAPI;
    if (!api) return null;
    const key = typeof keyOrRef === "string" ? keyOrRef : keyOrRef.key;
    const byKey = await api.readArtifactByKey?.(runSnapshot.runId, key);
    if (byKey?.success && byKey.mime && byKey.encoding && byKey.content !== undefined) {
      return { mime: byKey.mime, encoding: byKey.encoding, content: byKey.content };
    }

    const artifact = [...ctx.artifacts].reverse().find((a) => a.key === key);
    if (!artifact) return null;
    const byStorage = await api.readArtifact?.(runSnapshot.runId, artifact.storageKey);
    if (
      byStorage?.success &&
      byStorage.mime &&
      byStorage.encoding &&
      byStorage.content !== undefined
    ) {
      return {
        mime: byStorage.mime,
        encoding: byStorage.encoding,
        content: byStorage.content,
      };
    }
    return null;
  };

  return {
    readArtifact,
    readJsonArtifact: async <T = unknown>(keyOrRef: string | SdkArtifactRef) => {
      const artifact = await readArtifact(keyOrRef);
      if (!artifact || artifact.encoding !== "utf8") return undefined;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic deserialization boundary; caller declares the artifact's T
      return JSON.parse(artifact.content) as T;
    },
    getState: async <T = unknown>(key: string) => {
      const result = await window.workflowsAPI?.getStateValue?.(runSnapshot.workflowId, key);
      if (!result?.success || !result.state.found) return undefined;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic state read boundary; caller declares the value's T
      return result.state.value as T;
    },
    listStateKeys: async (prefix?: string) => {
      const result = await window.workflowsAPI?.listStateKeys?.(runSnapshot.workflowId, prefix);
      return result?.success ? (result.keys ?? []) : [];
    },
    listRunHistory: async (opts?: { limit?: number }) => {
      const result = await window.workflowsAPI?.listRuns?.(
        runSnapshot.workflowId,
        runSnapshot.repoPath ?? undefined,
      );
      const runs = result?.success ? (result.runs ?? []) : [];
      const adapted = runs.map(adaptRunHistoryEntry);
      if (opts?.limit === undefined || opts.limit < 0) return adapted;
      return adapted.slice(0, opts.limit);
    },
    getRun: async (runId: string) => {
      const result = await window.workflowsAPI?.getRun?.(runId);
      return result?.success && result.snapshot ? adaptRunSnapshot(result.snapshot) : null;
    },
  };
}

export function adaptRunHistoryEntry(entry: RunHistoryEntry): WorkflowRunHistoryEntry {
  return {
    runId: entry.runId,
    runFamilyId: entry.runFamilyId,
    workflowId: entry.workflowId,
    status: entry.status,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    parentRunId: entry.parentRunId,
  };
}

function mapStatusToSdk(
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "crashed",
): "queued" | "running" | "completed" | "crashed" | "cancelled" {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "completed";
    case "failed":
    case "crashed":
      return "crashed";
    case "cancelled":
      return "cancelled";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
