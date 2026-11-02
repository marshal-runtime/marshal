// src/features/workflows/commandCenterProps.ts
//
// Adapts the renderer-side `WorkflowCommandCenterContext` (from the slot) into
// the SDK's `WorkflowCommandCenterProps` — the workflow-LEVEL parallel of
// `rendererProps.ts`. State reads are workflow-scoped (`ctx.store`); artifact
// reads are explicitly run-scoped via `runId`.

import type { RunHistoryEntry } from "@common/workflows-contract";
import type {
  WorkflowActionDispatchRequest,
  WorkflowActionDispatchResult,
  WorkflowActionCenterItem,
  WorkflowArtifactContent,
  WorkflowCommandCenterApi,
  WorkflowCommandCenterProps,
  WorkflowNotificationOutboxItem,
} from "@marshal/workflow-sdk";

import { adaptRunHistoryEntry, adaptRunSnapshot } from "./rendererProps";

/** Mirrors the host's reserved UI-config namespace (see workflow-run-manager). */
const CONFIG_KEY_PREFIX = "config/";

interface WorkflowCommandCenterRendererContext {
  readonly workflowId: string;
  readonly repoPath?: string | null;
  readonly runs: ReadonlyArray<RunHistoryEntry>;
  readonly onOpenRun?: (runId: string) => void;
  readonly onLaunchSession?: (options: {
    title: string;
    prompt: string;
  }) => Promise<{ sessionId: string; title: string } | null>;
}

export function adaptCommandCenterProps(
  ctx: WorkflowCommandCenterRendererContext,
): WorkflowCommandCenterProps {
  return {
    workflowId: ctx.workflowId,
    runs: ctx.runs.map(adaptRunHistoryEntry),
    dashboard: createCommandCenterApi(ctx),
    actions: {
      openRun: (runId: string) => ctx.onOpenRun?.(runId),
      launchSession: async (options: { title: string; prompt: string }) => {
        return (await ctx.onLaunchSession?.(options)) ?? null;
      },
    },
  };
}

function createCommandCenterApi(
  ctx: WorkflowCommandCenterRendererContext,
): WorkflowCommandCenterApi {
  const readArtifact = async (
    runId: string,
    key: string,
  ): Promise<WorkflowArtifactContent | null> => {
    const result = await window.workflowsAPI?.readArtifactByKey?.(runId, key);
    if (result?.success && result.mime && result.encoding && result.content !== undefined) {
      return { mime: result.mime, encoding: result.encoding, content: result.content };
    }
    return null;
  };

  return {
    readArtifact,
    readJsonArtifact: async <T = unknown>(runId: string, key: string) => {
      const artifact = await readArtifact(runId, key);
      if (!artifact || artifact.encoding !== "utf8") return undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic deserialization boundary; caller declares the artifact's T
        return JSON.parse(artifact.content) as T;
      } catch {
        return undefined;
      }
    },
    getState: async <T = unknown>(key: string) => {
      const result = await window.workflowsAPI?.getStateValue?.(ctx.workflowId, key);
      if (!result?.success || !result.state.found) return undefined;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic state read boundary; caller declares the value's T
      return result.state.value as T;
    },
    getConfig: async <T = unknown>(key: string) => {
      const fullKey = key.startsWith(CONFIG_KEY_PREFIX) ? key : `${CONFIG_KEY_PREFIX}${key}`;
      const result = await window.workflowsAPI?.getStateValue?.(ctx.workflowId, fullKey);
      if (!result?.success || !result.state.found) return undefined;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- generic config read boundary; caller declares the value's T
      return result.state.value as T;
    },
    putConfig: async (key: string, value: unknown) => {
      const result = await window.workflowsAPI?.putConfigValue?.(
        ctx.workflowId,
        key,
        value,
        ctx.repoPath ?? undefined,
      );
      return result?.success ?? false;
    },
    listStateKeys: async (prefix?: string) => {
      const result = await window.workflowsAPI?.listStateKeys?.(ctx.workflowId, prefix);
      return result?.success ? (result.keys ?? []) : [];
    },
    clearState: async (options) => {
      const result = await window.workflowsAPI?.clearState?.({
        workflowId: ctx.workflowId,
        repoPath: ctx.repoPath ?? undefined,
        ...options,
      });
      return result?.success ? (result.result ?? null) : null;
    },
    listRunHistory: async (opts?: { limit?: number }) => {
      const result = await window.workflowsAPI?.listRuns?.(
        ctx.workflowId,
        ctx.repoPath ?? undefined,
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
    dispatchAction: async (
      request: WorkflowActionDispatchRequest,
    ): Promise<WorkflowActionDispatchResult | null> => {
      const result = await window.workflowsAPI?.dispatchAction?.({
        ...request,
        workflowId: ctx.workflowId,
        repoPath: ctx.repoPath ?? undefined,
      });
      return result?.success ? (result.result ?? null) : null;
    },
    getActionItem: async (itemId: string): Promise<WorkflowActionCenterItem | null> => {
      const result = await window.workflowsAPI?.getActionItem?.(
        ctx.workflowId,
        itemId,
        ctx.repoPath ?? undefined,
      );
      return result?.success ? (result.item ?? null) : null;
    },
    approveNotification: async (
      item: WorkflowNotificationOutboxItem,
    ): Promise<WorkflowActionDispatchResult | null> => {
      const result = await window.workflowsAPI?.approveNotification?.({
        workflowId: ctx.workflowId,
        item,
        repoPath: ctx.repoPath ?? undefined,
      });
      return result?.success ? (result.result ?? null) : null;
    },
  };
}
