import type {
  RuntimeUiApplicationHost as RuntimeUiCallbackHost,
  RuntimeUiInstance,
} from "@common/runtime-ui";
import type { ReactNode } from "react";

import type { MarshalRuntimeEditor } from "./RuntimeEditor";

export interface RuntimeUiApplicationRenderHost extends RuntimeUiCallbackHost {
  readonly editor: MarshalRuntimeEditor;
  readonly openSession?: (sessionId: string) => Promise<void>;
  /**
   * OMR2-1: shows the native assistant-session picker so the user can perform
   * a visible selection. Never selects or mints a grant by itself (§7).
   */
  readonly requestSessionPicker?: () => void;
}

export interface RuntimeUiApplicationRendererProps {
  readonly instance: RuntimeUiInstance;
  readonly host: RuntimeUiApplicationRenderHost;
}

export type RuntimeUiApplicationRenderer = (props: RuntimeUiApplicationRendererProps) => ReactNode;

const renderers = new Map<string, RuntimeUiApplicationRenderer>();

/** Register an application renderer by the stable extension-provided renderId. */
export function registerRuntimeUiApplicationRenderer(
  renderId: string,
  renderer: RuntimeUiApplicationRenderer,
): () => void {
  if (!renderId.trim()) throw new TypeError("Runtime UI renderer renderId is required.");
  renderers.set(renderId, renderer);
  return () => {
    if (renderers.get(renderId) === renderer) renderers.delete(renderId);
  };
}

export function getRuntimeUiApplicationRenderer(
  renderId: string,
): RuntimeUiApplicationRenderer | undefined {
  return renderers.get(renderId);
}

/**
 * True when RuntimeUiRenderer will fall through to the sandboxed HTML iframe
 * (PackagedRuntimeUiRenderer) for this instance, rather than a registered or
 * declarative renderer. Mirrors RuntimeUiRenderer's resolution order so host
 * chrome (RuntimeUiHost) can decide whether to hand height/scrolling to the
 * iframe document instead of wrapping it in the natural-height ScrollArea.
 */
export function isPackagedApplicationInstance(instance: RuntimeUiInstance): boolean {
  if (instance.content.kind !== "application") return false;
  const { renderId, resource, state } = instance.content;
  if (getRuntimeUiApplicationRenderer(renderId)) return false;
  if (state && "document" in state) return false;
  return resource.mimeType.split(";")[0].trim() === "text/html";
}
