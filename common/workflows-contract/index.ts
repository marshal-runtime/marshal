// common/workflows-contract/index.ts
//
// Barrel for the shared workflow contracts. Both `electron/workflows/`
// (engine) and `src/` (renderer) import from here so the wire schema has
// exactly one source of truth.

export * from "./bindings";
export * from "./events";
export * from "./manifest";
export * from "./operational";
export * from "./run-record";
export * from "./snapshot";
export * from "./ui-extras";

/** Canonical SessionSource literal — mirrored in c-persist §7. */
export const WORKFLOW_RUN_SOURCE = "workflow-run" as const;
