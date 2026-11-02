export interface RuntimeUiApplicationRendererPolicy {
  readonly renderId: string;
  readonly extensionIds: readonly string[];
  readonly applicationIds?: readonly string[];
  readonly capabilities: readonly string[];
  readonly resourceUris: readonly string[];
  readonly placementActivationCapability?: string;
}

export const OVERLAY_REVIEW_RENDER_ID = "marshal.overlay-review.v1";
export const OVERLAY_REVIEW_EXTENSION_ID = "@marshal/overlay-review";
export const OVERLAY_REVIEW_APPLICATION_ID = "overlay-review";
export const OVERLAY_REVIEW_LAUNCH_CAPABILITY = "overlay.review.launch";
export const AGENTIC_DEBUGGER_RENDER_ID = "marshal.agentic-debugger.v1";
export const AGENTIC_DEBUGGER_EXTENSION_ID = "@marshal/agentic-debugger-extension";
export const AGENTIC_BROWSER_RENDER_ID = "marshal.agentic-browser.v1";
export const AGENTIC_BROWSER_EXTENSION_ID = "@agentic-browser/marshal-runtime-extension";
export const AGENTIC_BROWSER_APPLICATION_ID = "browser-session";
export const AGENTIC_BROWSER_RESOURCE_URI = "runtime://browser/ui/application/v1";
export const BUILTIN_RUNTIME_UI_RENDERER_POLICIES: readonly RuntimeUiApplicationRendererPolicy[] =
  Object.freeze([
    Object.freeze({
      renderId: OVERLAY_REVIEW_RENDER_ID,
      extensionIds: Object.freeze([OVERLAY_REVIEW_EXTENSION_ID]),
      applicationIds: Object.freeze([OVERLAY_REVIEW_APPLICATION_ID]),
      capabilities: Object.freeze([OVERLAY_REVIEW_LAUNCH_CAPABILITY]),
      resourceUris: Object.freeze([]),
      placementActivationCapability: OVERLAY_REVIEW_LAUNCH_CAPABILITY,
    }),
    Object.freeze({
      renderId: AGENTIC_BROWSER_RENDER_ID,
      extensionIds: Object.freeze([AGENTIC_BROWSER_EXTENSION_ID]),
      applicationIds: Object.freeze([AGENTIC_BROWSER_APPLICATION_ID]),
      capabilities: Object.freeze([]),
      resourceUris: Object.freeze([]),
    }),
    Object.freeze({
      renderId: AGENTIC_DEBUGGER_RENDER_ID,
      extensionIds: Object.freeze([AGENTIC_DEBUGGER_EXTENSION_ID]),
      applicationIds: Object.freeze(["debugger"]),
      capabilities: Object.freeze([
        "debug.session.get",
        "debug.source.read",
        "debug.execution.continue",
        "debug.execution.pause",
        "debug.execution.stepOver",
        "debug.execution.stepInto",
        "debug.execution.stepOut",
        "debug.breakpoint.set",
        "debug.breakpoint.remove",
        "debug.breakpoint.enable",
        "debug.breakpoint.disable",
        "debug.watch.manage",
        "debug.inspect.evaluate",
      ]),
      resourceUris: Object.freeze(["runtime://debugger/ui/application/v1"]),
    }),
  ]);

export function findRuntimeUiApplicationRendererPolicy(
  renderId: string,
  extensionId: string,
  applicationId?: string,
): RuntimeUiApplicationRendererPolicy | undefined {
  return BUILTIN_RUNTIME_UI_RENDERER_POLICIES.find(
    (policy) =>
      policy.renderId === renderId &&
      policy.extensionIds.includes(extensionId) &&
      (!policy.applicationIds || !applicationId || policy.applicationIds.includes(applicationId)),
  );
}
