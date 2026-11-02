// src/features/workflows/useWorkflowCommandCenter.tsx
//
// Workflow-LEVEL parallel of `useWorkflowRenderer.tsx`. Fetches a workflow's
// optional compiled `command-center` bundle, loads it as a Blob (injecting the
// shared React runtime + a `defineCommandCenter` registration global), and
// registers the resulting component into the WORKFLOW_DETAIL_COMMAND_CENTER
// slot keyed on `workflowId`. When the workflow ships no command center the
// slot stays empty and the expandable section is simply absent.

import type { WorkflowRendererBundle } from "@common/workflows-contract";
import type { WorkflowCommandCenterProps } from "@marshal/workflow-sdk";
import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import * as React from "react";

import { extensionClient, SLOT } from "@/extensions";
import type { Extension1PManifest, SlotProps } from "@/extensions";
import { diagnosticLog } from "@/services/marshal-diagnostic-logger";

import { adaptCommandCenterProps } from "./commandCenterProps";

const loadedKeys = new Set<string>();

declare global {
  interface Window {
    __workflowCommandCenterRegister?: (workflowId: string, component: unknown) => void;
  }
}

/**
 * Loads + registers a workflow's optional command-center renderer. Returns
 * `true` once a command center is available for this workflow so the host can
 * render its expandable section only when there is something to show.
 */
export function useWorkflowCommandCenter(
  workflowId: string | null | undefined,
  repoPath?: string | null,
): boolean {
  // Track the workflow id a command center was confirmed for, rather than a
  // boolean we'd have to reset synchronously on workflow switch (which the
  // react-compiler set-state-in-effect rule forbids). `available` is derived.
  const [availableFor, setAvailableFor] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId) return undefined;
    let disposed = false;

    void (async () => {
      const api = window.workflowsAPI;
      if (!api?.getCommandCenter) {
        diagnosticLog.warn("CommandCenterUI", "getCommandCenter API missing on workflowsAPI");
        return;
      }
      const result = await api.getCommandCenter(workflowId, repoPath ?? undefined);
      if (disposed) return;
      if (!result.success || !result.commandCenter) {
        diagnosticLog.info("CommandCenterUI", "no command-center bundle", {
          workflowId,
          success: result.success,
          hasBundle: !!result.commandCenter,
          error: result.error,
        });
        return;
      }
      const bundle = result.commandCenter;
      if (loadedKeys.has(bundle.key)) {
        setAvailableFor(workflowId);
        return;
      }
      let component;
      try {
        component = await loadCommandCenterComponent(bundle);
      } catch (err) {
        diagnosticLog.error("CommandCenterUI", "loadCommandCenterComponent threw", {
          workflowId,
          codeLen: bundle.code.length,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
        return;
      }
      if (disposed) return;
      if (!component) {
        diagnosticLog.error("CommandCenterUI", "loadCommandCenterComponent returned no component", {
          workflowId,
          codeLen: bundle.code.length,
        });
        return;
      }
      const manifest = buildManifest(bundle, component);
      extensionClient.register(manifest);
      extensionClient.enable(manifest.id);
      loadedKeys.add(bundle.key);
      diagnosticLog.info("CommandCenterUI", "command center registered + enabled", { workflowId });
      setAvailableFor(workflowId);
    })().catch((err: unknown) => {
      diagnosticLog.error("CommandCenterUI", "command center load failed (outer)", {
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    });

    return () => {
      disposed = true;
    };
  }, [repoPath, workflowId]);

  return !!workflowId && availableFor === workflowId;
}

async function loadCommandCenterComponent(
  bundle: WorkflowRendererBundle,
): Promise<ComponentType<WorkflowCommandCenterProps> | null> {
  let candidate: ComponentType<WorkflowCommandCenterProps> | null = null;
  // The compiled bundle reads React from `__workflowRendererReact` (shared with
  // the run-level renderer runtime — it's the same React) and registers via
  // `__workflowCommandCenterRegister`.
  const previousReact = window.__workflowRendererReact;
  const previousRegister = window.__workflowCommandCenterRegister;
  window.__workflowRendererReact = React;
  window.__workflowCommandCenterRegister = (id, component) => {
    if (id !== bundle.workflowId || !isCommandCenterComponent(component)) return;
    candidate = component;
  };
  const blob = new Blob([bundle.code], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await import(/* @vite-ignore */ url);
    return candidate;
  } finally {
    URL.revokeObjectURL(url);
    window.__workflowRendererReact = previousReact;
    window.__workflowCommandCenterRegister = previousRegister;
  }
}

function buildManifest(
  bundle: WorkflowRendererBundle,
  CommandCenter: ComponentType<WorkflowCommandCenterProps>,
): Extension1PManifest {
  const extensionId = `com.marshal.workflow-command-center.${bundle.key.replace(
    /[^a-zA-Z0-9._-]/g,
    "-",
  )}`;

  function renderCommandCenterSlot({ ctx }: SlotProps<typeof SLOT.WORKFLOW_DETAIL_COMMAND_CENTER>) {
    return <CommandCenter {...adaptCommandCenterProps(ctx)} />;
  }

  return {
    origin: "marshal-shell",
    id: extensionId,
    displayName: `${bundle.workflowId} command center`,
    description: "User-installed workflow command center.",
    contributes: {
      slots: [
        {
          slotId: SLOT.WORKFLOW_DETAIL_COMMAND_CENTER,
          component: renderCommandCenterSlot,
          activateWhen: ({ workflowId }) => workflowId === bundle.workflowId,
        },
      ],
    },
  };
}

function isCommandCenterComponent(
  value: unknown,
): value is ComponentType<WorkflowCommandCenterProps> {
  return typeof value === "function";
}
