import type { WorkflowRendererBundle } from "@common/workflows-contract";
import type { WorkflowRunRendererProps } from "@marshal/workflow-sdk";
import { useEffect } from "react";
import type { ComponentType } from "react";
import * as React from "react";

import { extensionClient, SLOT } from "@/extensions";
import type { Extension1PManifest, SlotProps } from "@/extensions";

import { adaptWorkflowRendererProps } from "./rendererProps";

const loadedKeys = new Set<string>();

declare global {
  interface Window {
    __workflowRendererReact?: typeof React;
    __workflowRendererRegister?: (workflowId: string, component: unknown) => void;
  }
}

export function useUserWorkflowRenderer(
  workflowId: string | null | undefined,
  repoPath?: string | null,
): void {
  useEffect(() => {
    if (!workflowId) return undefined;
    let disposed = false;

    void (async () => {
      const api = window.workflowsAPI;
      if (!api?.getRenderer) return;
      const result = await api.getRenderer(workflowId, repoPath ?? undefined);
      if (disposed || !result.success || !result.renderer) return;
      const renderer = result.renderer;
      if (loadedKeys.has(renderer.key)) return;
      const component = await loadRendererComponent(renderer);
      if (disposed || !component) return;
      const manifest = buildManifest(renderer, component);
      extensionClient.register(manifest);
      extensionClient.enable(manifest.id);
      loadedKeys.add(renderer.key);
    })().catch(() => {
      // Broken user renderers should fall back to DefaultRunRenderer.
    });

    return () => {
      disposed = true;
    };
  }, [repoPath, workflowId]);
}

async function loadRendererComponent(
  renderer: WorkflowRendererBundle,
): Promise<ComponentType<WorkflowRunRendererProps> | null> {
  let candidate: ComponentType<WorkflowRunRendererProps> | null = null;
  const previousReact = window.__workflowRendererReact;
  const previousRegister = window.__workflowRendererRegister;
  window.__workflowRendererReact = React;
  window.__workflowRendererRegister = (workflowId, component) => {
    if (workflowId !== renderer.workflowId || !isRendererComponent(component)) return;
    candidate = component;
  };
  const blob = new Blob([renderer.code], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await import(/* @vite-ignore */ url);
    return candidate;
  } finally {
    URL.revokeObjectURL(url);
    window.__workflowRendererReact = previousReact;
    window.__workflowRendererRegister = previousRegister;
  }
}

function buildManifest(
  renderer: WorkflowRendererBundle,
  Renderer: ComponentType<WorkflowRunRendererProps>,
): Extension1PManifest {
  const extensionId = `com.marshal.workflow-renderer.${renderer.key.replace(/[^a-zA-Z0-9._-]/g, "-")}`;

  function renderUserWorkflowSlot({ ctx }: SlotProps<typeof SLOT.WORKFLOW_RUN_DETAIL>) {
    return <Renderer {...adaptWorkflowRendererProps(ctx)} />;
  }

  return {
    origin: "marshal-shell",
    id: extensionId,
    displayName: `${renderer.workflowId} renderer`,
    description: "User-installed workflow renderer.",
    contributes: {
      slots: [
        {
          slotId: SLOT.WORKFLOW_RUN_DETAIL,
          component: renderUserWorkflowSlot,
          activateWhen: ({ workflowId }) => workflowId === renderer.workflowId,
        },
      ],
    },
  };
}

function isRendererComponent(value: unknown): value is ComponentType<WorkflowRunRendererProps> {
  return typeof value === "function";
}
