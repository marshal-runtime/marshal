// ── Generic slot infrastructure ───────────────────────────────────────────────

/**
 * All registered slot IDs across the app.
 *
 * Each page or feature that introduces slots adds its keys here. Slot IDs are
 * namespaced by page (e.g. `"createPanel.*"`) to avoid collisions.
 *
 * Use these constants when registering a `SlotContribution` or rendering a
 * `<SlotRenderer>`.
 */
export const SLOT = {
  // ── Create Panel ───────────────────────────────────────────────────────────
  /** Left column: file tree, workspace switcher, navigation. */
  CREATE_PRIMARY_SIDEBAR: "createPanel.primarySidebar",

  /**
   * Thin bar at the top of the main content column.
   * Default: empty (no header rendered). Extensions can inject breadcrumbs,
   * status indicators, or action toolbars here.
   */
  CREATE_CONTENT_HEADER: "createPanel.contentHeader",

  /**
   * Main content area below the content header.
   * Default: `FilePreview` / empty state.
   */
  CREATE_EDITOR: "createPanel.editor",

  /** Right column: chat panel, secondary tools, contextual information. */
  CREATE_SECONDARY_SIDEBAR: "createPanel.secondarySidebar",

  /**
   * The icon element rendered next to a file node inside the file tree.
   * Context includes the node's `fileExtension` (e.g. `"md"`).
   * Contribute a `component` to replace the default `<FileIcon>` for matching nodes.
   */
  CREATE_PANEL_TREE_NODE_ICON: "createPanel.treeNodeIcon",

  // ── Workflows tab ─────────────────────────────────────────────────────────
  /**
   * Middle pane of the workflow run-detail page. The default fallback is the
   * three-column renderer in `src/features/workflows/DefaultRunRenderer.tsx`.
   * Per-workflow custom renderers register here with `activateWhen` keyed on
   * `ctx.workflowId`.
   */
  WORKFLOW_RUN_DETAIL: "workflowsPanel.runDetail",

  /**
   * Expandable section on the workflow DETAIL page (below the built-in
   * summary / schedule / run-history). Hosts a workflow-LEVEL custom renderer
   * (the persistent cross-run "command center"). Per-workflow renderers
   * register here with `activateWhen` keyed on `ctx.workflowId`; when none is
   * registered the section is simply absent (no fallback).
   */
  WORKFLOW_DETAIL_COMMAND_CENTER: "workflowsPanel.detailCommandCenter",
} as const;

export type SlotId = (typeof SLOT)[keyof typeof SLOT];

export const SLOT_LABEL: Readonly<Record<SlotId, string>> = {
  [SLOT.CREATE_PRIMARY_SIDEBAR]: "Primary Sidebar",
  [SLOT.CREATE_CONTENT_HEADER]: "Content Header",
  [SLOT.CREATE_EDITOR]: "Editor",
  [SLOT.CREATE_SECONDARY_SIDEBAR]: "Secondary Sidebar",
  [SLOT.CREATE_PANEL_TREE_NODE_ICON]: "Tree Node Icon",
  [SLOT.WORKFLOW_RUN_DETAIL]: "Workflow Run Detail",
  [SLOT.WORKFLOW_DETAIL_COMMAND_CENTER]: "Workflow Command Center",
};

// ── Generic slot context ──────────────────────────────────────────────────────

/**
 * Minimal context present in every slot, regardless of the page.
 * Extend this when defining page-specific or slot-specific context types.
 */
export type SlotContextBase = object;

// ── Create Panel slot contexts ────────────────────────────────────────────────

/**
 * Context shared by all slots in the Create Panel layout.
 *
 *  ┌──────────────────┬──────────────────────────────┬────────────────────┐
 *  │  PRIMARY_SIDEBAR │  CONTENT_HEADER              │                    │
 *  │                  ├──────────────────────────────│  SECONDARY_SIDEBAR │
 *  │  (file tree,     │  EDITOR                      │  (chat panel,      │
 *  │   workspaces)    │  (preview / editor / custom) │   contextual tools)│
 *  └──────────────────┴──────────────────────────────┴────────────────────┘
 */
export interface CreatePanelSlotContext extends SlotContextBase {
  /** Currently selected file path, or `null` if nothing is open. */
  activeFile: string | null;
  /** The frontmatter `type:` value of the active file, or `null`. */
  activeFileType: string | null;
  /** Name of the active workspace (e.g. `"Scratchpad"`). */
  workspace: string;
  /** Co-create session ID associated with the active workspace, or `null`. */
  sessionId: string | null;
}

/**
 * Context for `CREATE_PRIMARY_SIDEBAR`.
 *
 * Extends the base with `onFileSelect` — the canonical way for a custom
 * sidebar component to select a file and drive the panel state (persistence,
 * frontmatter type detection, etc.) without touching `window.*` directly.
 */
export interface CreatePanelPrimarySidebarContext extends CreatePanelSlotContext {
  /** Select a file. Persists the selection and runs frontmatter type detection. */
  onFileSelect: (filePath: string | null) => void;
}

/**
 * Context for `CREATE_PANEL_TREE_NODE_ICON`.
 *
 * Passed to every file-tree icon slot. Plugins use `fileExtension` in
 * `activateWhen` to target specific file types.
 */
export interface CreatePanelTreeNodeIconContext extends SlotContextBase {
  /** Lowercase file extension without the dot (e.g. `"md"`, `"tsx"`). Empty string for files with no extension. */
  fileExtension: string;
}

/**
 * Context for `WORKFLOW_RUN_DETAIL`.
 *
 * Custom per-workflow renderers receive this on every batched event push.
 * The renderer reads `runSnapshot` for its derived state, subscribes to
 * `events` for live deltas, calls `actions` for cancel/retry/openChat,
 * and uses `artifacts` to read inline artifact content. All inter-process
 * surface lives in `common/workflows-contract.ts` so renderers stay
 * decoupled from the engine implementation.
 */
export interface WorkflowRunRendererContext extends SlotContextBase {
  workflowId: string;
  runId: string;
  runSnapshot: import("@common/workflows-contract").RunSnapshot;
  events: import("@common/workflows-contract").WorkflowEvent[];
  actions: import("@common/workflows-contract").RunActions;
  artifacts: ReadonlyArray<import("@common/workflows-contract").ArtifactRefSummary>;
}

/**
 * Context for `WORKFLOW_DETAIL_COMMAND_CENTER`.
 *
 * Workflow-LEVEL (cross-run) renderers receive this on the workflow detail
 * page. Unlike the run-level context there is no single run/snapshot — the
 * renderer reads the workflow's durable `ctx.store` state and run history via
 * the `dashboard` API, scoped to `workflowId`.
 */
export interface WorkflowCommandCenterContext extends SlotContextBase {
  workflowId: string;
  repoPath?: string | null;
  runs: ReadonlyArray<import("@common/workflows-contract").RunHistoryEntry>;
  /** Open a run's detail page (embeds its agent session + artifacts). */
  onOpenRun?: (runId: string) => void;
  /** Create and seed a new chat session without forcing navigation. */
  onLaunchSession?: (options: {
    title: string;
    prompt: string;
  }) => Promise<{ sessionId: string; title: string } | null>;
}

/**
 * Maps every `SlotId` to its dedicated context type.
 *
 * `SlotRenderer` uses this map to enforce that the context passed to a slot
 * matches exactly what that slot expects — you cannot pass a sidebar context
 * to an editor slot or vice versa.
 */
export type SlotContextMap = {
  [SLOT.CREATE_PRIMARY_SIDEBAR]: CreatePanelPrimarySidebarContext;
  [SLOT.CREATE_CONTENT_HEADER]: CreatePanelSlotContext;
  [SLOT.CREATE_EDITOR]: CreatePanelSlotContext;
  [SLOT.CREATE_SECONDARY_SIDEBAR]: CreatePanelSlotContext;
  [SLOT.CREATE_PANEL_TREE_NODE_ICON]: CreatePanelTreeNodeIconContext;
  [SLOT.WORKFLOW_RUN_DETAIL]: WorkflowRunRendererContext;
  [SLOT.WORKFLOW_DETAIL_COMMAND_CENTER]: WorkflowCommandCenterContext;
};
