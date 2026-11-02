// Declared identity/capability/permission surface of the acceptance
// facility's sample app. Every script in ../scripts/ reads this module
// instead of re-declaring identity, so the "declared" side of every
// declare/grant receipt has exactly one source of truth.
export const SAMPLE_APP_IDENTITY = "@host-smoke/acceptance-sample";
export const SAMPLE_APP_VERSION = "1.0.0";
export const SAMPLE_APP_APPLICATION_ID = "acceptance-sample";
export const SAMPLE_APP_CAPABILITY_NAME = "acceptance-sample.read";
// A permission id shaped like the ones the code-review extension declares
// (e.g. "codereview.read") so kernel-mock evidence exercises the same
// declare -> grant -> deny-by-default shape D2 wires into production, without
// this facility redefining or re-exporting D2's actual authority code.
export const SAMPLE_APP_DECLARED_PERMISSION = "acceptance-sample.read";
export const SAMPLE_APP_UNDECLARED_PERMISSION = "acceptance-sample.undeclared-write";

// N-FF1: the real UiApplicationManifest field names are `actions[]` (entries with `id`) and `tools[]`
// (entries with `name`) — see node_modules/@marshal/agent-runtime-ui/dist/applicationTypes.d.ts. The
// previous `declaredActions` field was invented by this fixture and never emitted by any product
// surface, which made the identify step's declared-actions gate structurally unmeetable.
export const SAMPLE_APP_ACTIONS = Object.freeze([
  { id: "refresh", title: "Refresh", description: "Reload the paginated list from the provider." },
  { id: "select", title: "Select item", description: "Select a native list row." },
]);
export const SAMPLE_APP_TOOLS = Object.freeze([]);

export function sampleAppManifest() {
  return Object.freeze({
    identity: SAMPLE_APP_IDENTITY,
    version: SAMPLE_APP_VERSION,
    applicationId: SAMPLE_APP_APPLICATION_ID,
    capabilityName: SAMPLE_APP_CAPABILITY_NAME,
    declaredPermission: SAMPLE_APP_DECLARED_PERMISSION,
    actions: SAMPLE_APP_ACTIONS,
    tools: SAMPLE_APP_TOOLS,
  });
}
