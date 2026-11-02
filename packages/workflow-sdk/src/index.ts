// packages/workflow-sdk/src/index.ts
//
// `@marshal/workflow-sdk` — Authoring SDK for Marshal Dynamic Workflows.
//
// V1 surface lock: per r1-fixes.md A1. The author imports `defineWorkflow`,
// writes `run: async (ctx) => …`, and `export default`s the result. The
// engine `require()`s the compiled JS at run time, reads the default
// export, and invokes `definition.run(engineCtx)` with a concrete `ctx`
// object built by the engine.
//
// The SDK contains NO runtime indirection — `defineWorkflow` is a frozen
// pass-through. The `WorkflowContext` interface is a TYPE; the engine is
// the only place a concrete implementation exists. This keeps the
// compiled `dist/workflow.js` small (~ few KB) and removes a class of
// "SDK build version vs engine build version" mismatch bugs.

import type { z, ZodTypeAny } from "zod";

/**
 * Reasoning-effort levels supported by the Copilot CLI runtime. The authoring
 * SDK stays dependency-free, and the engine validates the chosen value against
 * the active model's supported set at spawn time.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

// ─── Authoring entry points ──────────────────────────────────────────────────

/**
 * Define a workflow. Returns a frozen plain object that the engine
 * `require()`s as the default export of `dist/workflow.js`.
 *
 * @example
 * ```ts
 * export default defineWorkflow({
 *   id: "demo-workflow",
 *   displayName: "Demo Workflow",
 *   schemaVersion: 1,
 *   run: async (ctx) => {
 *     const greeting = await ctx.step("greet", async () => `hello ${ctx.input.name}`);
 *     return { greeting };
 *   },
 * });
 * ```
 */
export function defineWorkflow<TInput = unknown, TOutput = unknown>(
  spec: WorkflowSpec<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput> {
  if (typeof spec.id !== "string" || spec.id.length === 0) {
    throw new TypeError("[@marshal/workflow-sdk] defineWorkflow: id is required");
  }
  if (typeof spec.run !== "function") {
    throw new TypeError("[@marshal/workflow-sdk] defineWorkflow: run must be a function");
  }
  // The engine reads these fields off the default export at run time. Use
  // `Object.freeze` so an over-eager workflow author can't mutate the
  // returned definition after the engine has captured it.
  return Object.freeze({
    id: spec.id,
    displayName: spec.displayName,
    description: spec.description,
    schemaVersion: spec.schemaVersion ?? 1,
    paramsSchema: spec.params,
    outputSchema: spec.output,
    defaultBudget: spec.defaultBudget,
    defaultModel: spec.defaultModel,
    defaultReasoningEffort: spec.defaultReasoningEffort,
    notifyOnComplete: spec.notifyOnComplete ?? "none",
    externalContext: spec.externalContext ? Object.freeze({ ...spec.externalContext }) : undefined,
    agentRequirements: spec.agentRequirements
      ? Object.freeze(spec.agentRequirements.map((r) => Object.freeze({ ...r })))
      : undefined,
    run: spec.run,
  }) as WorkflowDefinition<TInput, TOutput>;
}

/**
 * Define a custom renderer for a workflow's run-detail view. V1
 * user-installed workflows cannot register renderers; the engine emits a
 * warning at install time. Bundled workflows ship a `renderer.tsx` that
 * is wired through the renderer registry by `electron/main.ts`.
 */
export function defineRenderer<TRunState = unknown>(
  spec: RendererSpec<TRunState>,
): RendererDefinition<TRunState> {
  if (typeof spec.workflowId !== "string" || spec.workflowId.length === 0) {
    throw new TypeError("[@marshal/workflow-sdk] defineRenderer: workflowId is required");
  }
  if (typeof spec.render !== "function") {
    throw new TypeError("[@marshal/workflow-sdk] defineRenderer: render must be a function");
  }
  return Object.freeze({ ...spec }) as RendererDefinition<TRunState>;
}

/**
 * Define a workflow-LEVEL command center: a custom React view rendered on the
 * workflow detail page (below the built-in summary/run-history), scoped to the
 * WHOLE workflow rather than a single run. Unlike `defineRenderer` (per-run),
 * the command center is the persistent cross-run "brain" — it reads the
 * workflow's durable `ctx.store` state and run history via its dashboard API.
 *
 * Ships as a `command-center.tsx` next to `workflow.ts`; the engine compiles
 * and loads it through the Workflows-tab slot system, same path as renderers.
 */
export function defineCommandCenter(spec: CommandCenterSpec): CommandCenterDefinition {
  if (typeof spec.workflowId !== "string" || spec.workflowId.length === 0) {
    throw new TypeError("[@marshal/workflow-sdk] defineCommandCenter: workflowId is required");
  }
  if (typeof spec.render !== "function") {
    throw new TypeError("[@marshal/workflow-sdk] defineCommandCenter: render must be a function");
  }
  return Object.freeze({ ...spec }) as CommandCenterDefinition;
}
export function defineArtifact<T = unknown>(spec: ArtifactKindSpec<T>): ArtifactKind<T> {
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    throw new TypeError("[@marshal/workflow-sdk] defineArtifact: name is required");
  }
  return Object.freeze({ name: spec.name }) as ArtifactKind<T>;
}

// ─── Error classes — `instanceof` must work, so value exports ───────────────

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export class StepFailedError extends WorkflowError {
  constructor(
    public readonly stepKey: string,
    public readonly cause: unknown,
  ) {
    super(`Step ${stepKey} failed: ${String(cause)}`);
    this.name = "StepFailedError";
  }
}

export class SpawnTimeoutError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = "SpawnTimeoutError";
  }
}

export class UnitFailureBudgetExceededError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = "UnitFailureBudgetExceededError";
  }
}

export class CancelledError extends WorkflowError {
  constructor(message = "Workflow run cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export class ArtifactValidationError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

export class WorkflowContextNotBoundError extends WorkflowError {
  constructor() {
    super(
      "WorkflowContext is not bound. ctx.* methods must be called from inside a run(ctx) function.",
    );
    this.name = "WorkflowContextNotBoundError";
  }
}

/** Thrown when memoised step output disagrees with the replay invocation. */
export class MemoMismatchError extends WorkflowError {
  constructor(
    public readonly stepKey: string,
    message?: string,
  ) {
    super(message ?? `Memo mismatch for step ${stepKey}`);
    this.name = "MemoMismatchError";
  }
}

/** Thrown when a fanOut on replay produces a different item set. */
export class FanOutItemDriftError extends WorkflowError {
  constructor(
    public readonly stepKey: string,
    public readonly expected: ReadonlyArray<string>,
    public readonly actual: ReadonlyArray<string>,
  ) {
    super(`FanOut at ${stepKey} drifted: expected ${expected.length} items, got ${actual.length}`);
    this.name = "FanOutItemDriftError";
  }
}

export class BackendUnsupportedError extends WorkflowError {
  constructor(
    public readonly backendOrigin: string,
    message?: string,
  ) {
    super(message ?? `Workflows are not supported on backend "${backendOrigin}"`);
    this.name = "BackendUnsupportedError";
  }
}

export class PermissionDeniedError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export class CompileError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = "CompileError";
  }
}

export class MissingDefaultExportError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = "MissingDefaultExportError";
  }
}

export class RendererSlotConflict extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = "RendererSlotConflict";
  }
}

export class WorkflowStoreSchemaError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowStoreSchemaError";
  }
}

export class StoreQuotaExceededError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = "StoreQuotaExceededError";
  }
}

export class ExternalContextMissingError extends WorkflowError {
  constructor(message: string) {
    super(message);
    this.name = "ExternalContextMissingError";
  }
}

/**
 * Generic NotImplemented kept for API stability — the foundations shell
 * threw this; downstream code may still reference it.
 */
export class NotImplementedError extends Error {
  constructor(symbol: string) {
    super(`[@marshal/workflow-sdk] ${symbol} is not implemented`);
    this.name = "NotImplementedError";
  }
}

// ─── Definition / metadata types ─────────────────────────────────────────────

export interface WorkflowMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly schemaVersion: number;
}

export interface WorkflowDefinition<TInput = unknown, TOutput = unknown> extends WorkflowMetadata {
  readonly paramsSchema?: ZodTypeAny;
  readonly outputSchema?: ZodTypeAny;
  readonly defaultBudget?: WorkflowBudget | number;
  /** Default model for every session this workflow runs — the host
   *  orchestrator and all spawned subagents — unless a spawn overrides it via
   *  `SpawnOptions.model`. Falls back to the workflow tier default (Settings). */
  readonly defaultModel?: string;
  /** Default reasoning effort for this workflow's sessions, overridable per
   *  spawn via `SpawnOptions.reasoningEffort`. Falls back to the workflow tier
   *  default (Settings), then the model-aware system default. */
  readonly defaultReasoningEffort?: ReasoningEffort;
  readonly notifyOnComplete: "system" | "none";
  readonly externalContext?: ExternalContext;
  /**
   * Optional declared agent requirements. Each entry names a `slot` the
   * workflow author references at runtime via `ctx.run({ slot })` /
   * `ctx.spawn({ slot })`. At install time the installing agent (or the
   * bundled install script) decides how each slot is satisfied — see
   * `common/workflows-contract/bindings.ts` for the discriminated
   * binding kinds. Per the FEAT-SLOTS spec: one model, three resolution
   * strategies, chosen at install.
   */
  readonly agentRequirements?: readonly AgentRequirement[];
  readonly run: (ctx: WorkflowContext<TInput>) => Promise<TOutput>;
}

export interface WorkflowBudget {
  readonly maxConcurrentSubagents?: number;
  readonly maxTotalSubagents?: number;
  readonly defaultSpawnTimeoutMs?: number;
}

/**
 * Typed workflow spec. Two ways to land here:
 *
 *  1. **Inferred input (preferred):** omit the `TInput` generic and let
 *     `params: z.ZodType<TInput>` drive inference. The `run`'s `ctx.input`
 *     then matches your schema automatically.
 *     ```ts
 *     defineWorkflow({ params: z.object({ name: z.string() }), run: async (ctx) => { ctx.input.name } });
 *     ```
 *
 *  2. **Explicit input:** pass both generics. Useful when the schema is
 *     not declared inline.
 *     ```ts
 *     defineWorkflow<z.infer<typeof Params>, Result>({ params: Params, run });
 *     ```
 *
 * `defaultBudget` accepts a plain `number` (interpreted as
 * `maxConcurrentSubagents`) or the structured `WorkflowBudget` shape so
 * the foundation's shorthand keeps compiling.
 */
export interface WorkflowSpec<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly schemaVersion?: number;
  readonly params?: z.ZodType<TInput>;
  readonly output?: z.ZodType<TOutput>;
  readonly defaultBudget?: WorkflowBudget | number;
  /** Default model for the workflow's host orchestrator and spawned subagents
   *  (overridable per spawn via `SpawnOptions.model`). Falls back to the
   *  workflow tier default configured in Settings. */
  readonly defaultModel?: string;
  /** Default reasoning effort for the workflow's sessions (overridable per
   *  spawn via `SpawnOptions.reasoningEffort`). Falls back to the workflow tier
   *  default, then the model-aware system default. */
  readonly defaultReasoningEffort?: ReasoningEffort;
  readonly notifyOnComplete?: "system" | "none";
  readonly externalContext?: ExternalContext;
  /**
   * Declared agent slots — see `WorkflowDefinition.agentRequirements`.
   * Optional; workflows that always pass `agentName` directly to
   * `ctx.run` / `ctx.spawn` may omit this.
   */
  readonly agentRequirements?: readonly AgentRequirement[];
  readonly run: (ctx: WorkflowContext<TInput>) => Promise<TOutput>;
}

export type WorkflowParams<W> = W extends WorkflowDefinition<infer I, unknown> ? I : never;
export type WorkflowResult<W> = W extends WorkflowDefinition<unknown, infer O> ? O : never;

export interface WorkflowLogger {
  debug: (message: string, payload?: unknown) => void;
  info: (message: string, payload?: unknown) => void;
  warn: (message: string, payload?: unknown) => void;
  error: (message: string, payload?: unknown) => void;
}

export interface ExternalContext {
  /**
   * Absolute path to the authoritative `.github` folder whose agents and
   * skills should be available to workflow-launched subagents.
   */
  readonly githubFolderPath: string;
  /**
   * When true, workflow spawns default to this context unless a spawn sets
   * `repoPath`, `workspaceName`, or `githubFolderPath` explicitly.
   */
  readonly applyAsDefault?: boolean;
}

export interface WorkflowScheduleContext {
  readonly key: string;
  readonly naturalLanguage: string;
  readonly occurrenceAt: number;
  readonly checkedAt: number;
}

export interface WorkflowStoreEntry {
  readonly key: string;
  readonly sizeBytes: number;
  readonly writtenAt: number;
  readonly ttlMs?: number;
  readonly expiresAt?: number;
  readonly runId?: string;
}

export interface WorkflowStoreValue<T = unknown> extends WorkflowStoreEntry {
  readonly value: T;
}

export interface WorkflowStoreCompactionResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly bytesFreed: number;
  readonly deletedKeys: ReadonlyArray<string>;
}

export interface WorkflowStoreCompactionOptions {
  readonly prefix?: string;
  readonly olderThanMs?: number;
  readonly limit?: number;
}

export interface WorkflowStore {
  get<T = unknown>(key: string, schema?: z.ZodType<T>): Promise<T | undefined>;
  getEntry<T = unknown>(
    key: string,
    schema?: z.ZodType<T>,
  ): Promise<WorkflowStoreValue<T> | undefined>;
  put<T = unknown>(key: string, value: T, opts?: { ttlMs?: number }): Promise<void>;
  patch<T = unknown>(
    key: string,
    fn: (prev: T | undefined) => T,
    schema?: z.ZodType<T>,
    opts?: { ttlMs?: number },
  ): Promise<T>;
  delete(key: string): Promise<void>;
  listKeys(prefix?: string): Promise<readonly string[]>;
  listEntries(prefix?: string): Promise<readonly WorkflowStoreEntry[]>;
  compact(opts?: WorkflowStoreCompactionOptions): Promise<WorkflowStoreCompactionResult>;
}

export interface WorkflowParentNotificationResult {
  readonly delivered: boolean;
  readonly status: "sent" | "responded" | "unavailable";
  readonly response?: string;
}

// ─── `WorkflowContext` (`ctx`) — locked by R1-FIXES A1 ───────────────────────

export type DeliveryMode = "wait-if-idle" | "queue" | "interrupt";

export interface WorkflowScheduleCursor {
  readonly shiftId?: string;
  readonly shiftStartAt?: number;
  readonly coveredThrough?: number;
  readonly active?: boolean;
  readonly lastRunId?: string;
  readonly updatedAt?: number;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface WorkflowScheduleIncrementalWindow {
  readonly previous?: WorkflowScheduleCursor;
  readonly windowStartAt: number;
  readonly windowEndAt: number;
}

export interface WorkflowStageContext {
  readonly stageId: string;
  readonly label?: string;
  readonly summary?: string;
  readonly artifactFolders?: ReadonlyArray<{
    runId: string;
    prefix: string;
    artifactCount?: number;
  }>;
  readonly artifacts?: ReadonlyArray<{
    runId: string;
    key: string;
    storageKey?: string;
    label?: string;
  }>;
  readonly files?: ReadonlyArray<{ path: string; label?: string; reason?: string }>;
  readonly agentContext?: Readonly<Record<string, unknown>>;
}

export type WorkflowInvestigationCompletionState =
  | "pending_agent"
  | "agent_finished"
  | "approved"
  | "rejected"
  | "intervened"
  | "expired"
  | "cancelled"
  | "error";

export interface WorkflowInvestigationCompletionUpdate {
  readonly incidentId: string;
  readonly state: WorkflowInvestigationCompletionState;
  readonly reason?: string;
  readonly actor?: string;
  readonly markdownArtifactKey?: string;
  readonly jsonArtifactKey?: string;
  readonly chatLinks?: ReadonlyArray<WorkflowChatLink>;
}

export interface WorkflowChatLink {
  readonly sessionId: string;
  readonly runId?: string;
  readonly handleId?: string;
  readonly label?: string;
  readonly reason?: string;
}

export interface WorkflowActionCenterItem {
  readonly id: string;
  readonly title: string;
  readonly status?: string;
  readonly why?: string;
  readonly evidence?: ReadonlyArray<{
    label: string;
    detail?: string;
    artifacts?: ReadonlyArray<{ runId: string; key: string; storageKey?: string; label?: string }>;
    chats?: ReadonlyArray<WorkflowChatLink>;
    files?: ReadonlyArray<{ path: string; label?: string; reason?: string }>;
  }>;
  readonly supportingDetails?: ReadonlyArray<string>;
  readonly artifacts?: ReadonlyArray<{
    runId: string;
    key: string;
    storageKey?: string;
    label?: string;
  }>;
  readonly chats?: ReadonlyArray<WorkflowChatLink>;
  readonly safeToSend?: boolean;
  readonly ownerAlias?: string;
}

export interface WorkflowContext<TInput = unknown> {
  readonly runId: string;
  readonly runFamilyId: string;
  readonly workflowId: string;
  readonly input: TInput;
  readonly externalContext?: { readonly githubFolderPath: string };
  /**
   * Absolute filesystem root of the repo a repo-local workflow was loaded
   * from (`<repoPath>/.github/marshal-workflows/<id>/`). Undefined for non-repo
   * (bundled / user-installed) workflows. Lets repo-local workflows build
   * paths relative to their own checkout instead of hardcoding absolutes,
   * so the workflow stays portable across machines/clones.
   */
  readonly repoPath?: string;
  readonly schedule?: WorkflowScheduleContext & {
    readonly incremental?: WorkflowScheduleIncrementalWindow;
  };
  readonly store: WorkflowStore;
  readonly cancelled: AbortSignal;
  readonly log: WorkflowLogger;

  // Steps & control-flow
  step<T>(id: string, fn: () => Promise<T>): Promise<T>;
  try<T>(
    id: string,
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: Error }>;
  now(): number;
  sleep(ms: number): Promise<void>;

  // Deterministic helpers (memoised per call site)
  random(): number;
  uuid(): string;
  idempotencyKey(scope: string): string;

  // Subagent spawning
  spawn(opts: SpawnOptions): Promise<AgentHandle>;
  send(handle: AgentHandle, text: string, opts?: { deliveryMode?: DeliveryMode }): Promise<void>;
  waitForReply(handle: AgentHandle, opts?: WaitForReplyOptions): Promise<AgentMessage>;
  waitForIdle(handle: AgentHandle, opts?: { timeoutMs?: number }): Promise<void>;
  run<TOutput = unknown>(
    opts: SpawnOptions,
    prompt: string,
    opts2?: RunOptions<TOutput>,
  ): Promise<TOutput>;

  // FanOut / control-flow
  fanOut<TItem, TOut>(
    items: readonly TItem[],
    fn: (item: TItem, idx: number) => Promise<TOut>,
    opts?: FanOutOptions<TItem, TOut>,
  ): Promise<FanOutResult<TOut>>;
  all<T extends readonly Promise<unknown>[] | []>(
    promises: T,
  ): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  race<T>(promises: readonly Promise<T>[]): Promise<T>;

  // Artifacts (flat — locked by R1-FIXES A1)
  saveArtifact(
    key: string,
    content: Uint8Array | string,
    opts?: { mime?: string },
  ): Promise<ArtifactRef>;
  readArtifact(key: string): Promise<Uint8Array>;
  listArtifacts(prefix?: string): Promise<ReadonlyArray<ArtifactRef>>;

  // Shell — promoted to V1 per R1-FIXES A17
  shell(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<string>;

  // Compensators (per-run LIFO; see r1-fixes "compensator scope")
  onUndo(fn: () => Promise<void>): void;

  // Events / observability
  emit(name: string, data?: unknown): void;
  advanceScheduleCursor(cursor: WorkflowScheduleCursor): Promise<WorkflowScheduleCursor>;
  exposeStageContext(context: WorkflowStageContext): Promise<void>;
  transitionInvestigationCompletion(update: WorkflowInvestigationCompletionUpdate): Promise<void>;
  setActionCenterItems(
    items: ReadonlyArray<WorkflowActionCenterItem>,
    opts?: { replace?: boolean },
  ): Promise<void>;
  notifyParent(
    message: string,
    opts?: { waitForResponse?: boolean; timeoutMs?: number },
  ): Promise<WorkflowParentNotificationResult>;
}

// ─── Spawn types ─────────────────────────────────────────────────────────────

export interface SpawnOptions {
  readonly displayName?: string;
  /**
   * Explicit repo-local custom agent name to load into the subagent's
   * system context. Mutually exclusive with `slot` (engine throws if both
   * are set). Pre-FEAT-SLOTS workflows pass this directly; new workflows
   * should declare slots in `agentRequirements` and reference them here.
   */
  readonly agentName?: string;
  /**
   * Reference to a slot declared in the workflow's
   * `agentRequirements`. The engine resolves the slot to a concrete
   * agent (or default-with-role preamble) using the run's binding map at
   * spawn time. Mutually exclusive with `agentName`.
   */
  readonly slot?: string;
  readonly model?: string;
  /** Per-spawn reasoning-effort override. Falls back to the workflow's
   *  `defaultReasoningEffort`, then the workflow tier default, then High. */
  readonly reasoningEffort?: ReasoningEffort;
  readonly personality?: string;
  readonly permissionMode?: "default" | "allow-all";
  readonly workspaceName?: string;
  readonly repoPath?: string;
  /**
   * Absolute path to a `.github` folder to use for this spawn's repo-local
   * agents and skills. The runtime maps it to the containing folder before
   * delegating to SessionManager's existing repoPath-based lookup.
   */
  readonly githubFolderPath?: string;
  readonly createWorktree?: boolean;
  readonly worktreeName?: string;
  readonly branchName?: string;
  readonly baseRef?: string;
  /** Per-spawn skill scoping (R1-FIXES A13). Replaces defaults when supplied. */
  readonly skills?: readonly string[];
  /** Per-spawn MCP scoping (R1-FIXES A13). Replaces defaults when supplied. */
  readonly mcp?: readonly string[];
  /** Spawn-level timeout for the entire subagent lifecycle. */
  readonly timeoutMs?: number;
}

// ─── Agent slot / binding declaration types ──────────────────────────────────
//
// The full binding model (discriminated `Binding` union, `BindingsFile`
// schema, install-time validation helpers) lives in
// `common/workflows-contract/bindings.ts`. The SDK only declares the
// REQUIREMENTS side — what the workflow author asks for. Bindings are
// authored at install time, not in workflow source.

export interface AgentRequirement {
  /** Free-form slot id referenced by `ctx.run({ slot })` / `ctx.spawn`. */
  readonly slot: string;
  /** Short prose describing the role; surfaced to the installing agent. */
  readonly role: string;
  /**
   * Optional personality overlay. When the slot resolves to a
   * `default-with-role` binding, the engine prepends this fragment plus
   * the `role` to the user's prompt. Bindings of other kinds (repo /
   * shipped / create) may inherit it as a hint but the agent.md file
   * wins for those kinds.
   */
  readonly defaultPersonality?: string;
  /**
   * Optional shipped agent. When present, bundled installs default-bind
   * the slot to a `shipped-agent` binding pointing at
   * `<workflowDir>/<defaultAgent.agentMdPath>`. Repo-scoped installs may
   * still override.
   */
  readonly defaultAgent?: {
    /** Path relative to the workflow folder, e.g. `agents/investigator.agent.md`. */
    readonly agentMdPath: string;
  };
}

/**
 * Options for `ctx.run`. Pass `schema` and the engine validates the
 * parsed assistant reply against it, so `TOutput` infers from the
 * supplied Zod schema without needing an explicit generic:
 *
 *   const result = await ctx.run(spawnOpts, prompt, { schema: ReplySchema });
 *   //    ^? z.infer<typeof ReplySchema>
 */
export interface RunOptions<TOutput = unknown> {
  readonly schema?: z.ZodType<TOutput>;
  readonly timeoutMs?: number;
  readonly _outputBrand?: TOutput; // phantom — preserves the generic in inference
}

export interface AgentHandle {
  readonly handleId: string;
  readonly sessionId: string;
}

export interface AgentMessage {
  readonly text: string;
  readonly raw?: unknown;
}

export interface WaitForReplyOptions {
  readonly timeoutMs?: number;
}

// ─── FanOut types ────────────────────────────────────────────────────────────

/**
 * Fan-out unit failure policy. Per r1-fixes "fanOut failure policy
 * naming" the canonical V1 shape is the flat form below — `"abort"` /
 * `"continue"` plus the discriminated `failFraction` / `failCount`
 * objects.
 *
 * The legacy `{ kind }` shape from the foundations shell is also
 * accepted for backwards-compat with the bundled `workflow-author`
 * skill's worked examples. Engine normalises both into the canonical
 * form. Lint rule `deprecated-fanout-policy` (V1.1) will autofix the
 * legacy shape onto the canonical form.
 */
export type UnitFailurePolicy =
  | "abort"
  | "continue"
  | { readonly failFraction: number }
  | { readonly failCount: number }
  // Legacy `{ kind }` shape — kept for compat. Equivalent mapping:
  //   { kind: "fail-fast" }            → "abort"
  //   { kind: "continue" }             → "continue"
  //   { kind: "budget", maxFailures }  → { failCount: maxFailures }
  | { readonly kind: "fail-fast" }
  | { readonly kind: "continue" }
  | { readonly kind: "budget"; readonly maxFailures: number };

export interface FanOutOptions<TItem, TResult> {
  readonly maxConcurrency?: number;
  readonly keyFor?: (item: TItem, index: number) => string;
  readonly onUnitFailure?: UnitFailurePolicy;
  readonly _resultBrand?: TResult; // phantom
}

/**
 * Result of a fanOut. When `onUnitFailure: "continue"`, the engine widens
 * the return type to a discriminated union. Author types it with a cast
 * or by reading the policy literal.
 */
export type FanOutResult<TResult> = ReadonlyArray<
  | TResult
  | { readonly ok: true; readonly value: TResult }
  | { readonly ok: false; readonly error: Error }
>;

// ─── Artifact types ──────────────────────────────────────────────────────────

export interface ArtifactKindSpec<T> {
  readonly name: string;
  readonly schema?: ZodTypeAny;
  readonly mime?: string;
  readonly _brand?: T; // phantom
}

export interface ArtifactKind<T> {
  readonly name: string;
  readonly _brand?: T; // phantom
}

export type ArtifactNamespace = "run" | "fanout";

export interface ArtifactRef<T = unknown> {
  readonly key: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly writtenAt: number;
  readonly namespace: ArtifactNamespace;
  readonly _brand?: T; // phantom — preserves the typed artifact's value type
}

// ─── Renderer types ──────────────────────────────────────────────────────────

export type RunStatus = "queued" | "running" | "completed" | "crashed" | "cancelled";

export interface StepView {
  readonly id: string;
  readonly stepKey: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: { message: string; stack?: string };
}

export interface WorkflowRunState<TRunState = unknown> {
  readonly runId: string;
  readonly runFamilyId: string;
  readonly workflowId: string;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly steps: ReadonlyArray<StepView>;
  readonly state?: TRunState;
}

export interface WorkflowArtifactContent {
  readonly mime: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
}

export interface WorkflowRunHistoryEntry {
  readonly runId: string;
  readonly runFamilyId: string;
  readonly workflowId: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "crashed";
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly parentRunId?: string;
}

export interface WorkflowDashboardApi {
  readArtifact(key: string | ArtifactRef): Promise<WorkflowArtifactContent | null>;
  readJsonArtifact<T = unknown>(key: string | ArtifactRef): Promise<T | undefined>;
  getState<T = unknown>(key: string): Promise<T | undefined>;
  listStateKeys(prefix?: string): Promise<readonly string[]>;
  listRunHistory(opts?: { limit?: number }): Promise<readonly WorkflowRunHistoryEntry[]>;
  getRun(runId: string): Promise<WorkflowRunState | null>;
}

export interface WorkflowStateClearOptions {
  readonly keys?: ReadonlyArray<string>;
  readonly prefixes?: ReadonlyArray<string>;
  readonly includeConfig?: boolean;
}

export interface WorkflowStateClearError {
  readonly key?: string;
  readonly prefix?: string;
  readonly message: string;
}

export interface WorkflowStateClearResult {
  readonly workflowId: string;
  readonly scanned: number;
  readonly deleted: number;
  readonly deletedKeys: ReadonlyArray<string>;
  readonly preservedConfigKeys: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<WorkflowStateClearError>;
}

export interface WorkflowRunRendererProps<TRunState = unknown> {
  readonly run: WorkflowRunState<TRunState>;
  readonly artifacts: ReadonlyArray<ArtifactRef>;
  readonly dashboard: WorkflowDashboardApi;
}

export interface RendererSpec<TRunState = unknown> {
  readonly workflowId: string;
  readonly render: (props: WorkflowRunRendererProps<TRunState>) => unknown;
}

export interface RendererDefinition<TRunState = unknown> extends RendererSpec<TRunState> {
  readonly _brand?: TRunState; // phantom
}

// ─── Workflow-level command center types ─────────────────────────────────────

/**
 * Read surface a command center renderer uses to read the workflow's durable,
 * cross-run state. State reads (`getState`/`listStateKeys`) hit the workflow's
 * own `ctx.store`; artifact reads are explicitly run-scoped via `runId`.
 *
 * Writes are confined to UI-owned CONFIG: `putConfig`/`getConfig` read & write
 * keys under a reserved `config/` namespace (the host enforces the prefix), so
 * a command center can persist knobs (notification routing, toggles, outbox
 * approvals) for the workflow to consume on its next run WITHOUT being able to
 * clobber engine-owned operational state (cursors, portfolios, shift state).
 */
export interface WorkflowCommandCenterApi {
  getState<T = unknown>(key: string): Promise<T | undefined>;
  listStateKeys(prefix?: string): Promise<readonly string[]>;
  clearState(options?: WorkflowStateClearOptions): Promise<WorkflowStateClearResult | null>;
  listRunHistory(opts?: { limit?: number }): Promise<readonly WorkflowRunHistoryEntry[]>;
  getRun(runId: string): Promise<WorkflowRunState | null>;
  readArtifact(runId: string, key: string): Promise<WorkflowArtifactContent | null>;
  readJsonArtifact<T = unknown>(runId: string, key: string): Promise<T | undefined>;
  /** Read a UI-owned config value (stored under the reserved `config/` namespace). */
  getConfig<T = unknown>(key: string): Promise<T | undefined>;
  /**
   * Persist a UI-owned config value the workflow reads on its next run. Stored
   * under the reserved `config/` namespace; cannot touch engine-owned state.
   * The workflow reads it back via `ctx.store.get("config/<key>")`.
   */
  putConfig<T = unknown>(key: string, value: T): Promise<boolean>;
  dispatchAction(
    request: WorkflowActionDispatchRequest,
  ): Promise<WorkflowActionDispatchResult | null>;
  getActionItem(itemId: string): Promise<WorkflowActionCenterItem | null>;
  approveNotification(
    item: WorkflowNotificationOutboxItem,
  ): Promise<WorkflowActionDispatchResult | null>;
}

export type WorkflowActionDispatchStatus =
  | "proposed"
  | "pending"
  | "running"
  | "active"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowActionCenterStatusFilter =
  | "all"
  | "pending-proposed"
  | "active-running"
  | "completed"
  | "failed-cancelled";

export interface WorkflowActionDispatchState {
  readonly status: WorkflowActionDispatchStatus;
  readonly linkedSessionId?: string;
  readonly attempt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly lastError?: string;
}

export interface WorkflowActionCenterItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly workflowId: string;
  readonly runId?: string;
  readonly incidentId?: string;
  readonly dispatch: WorkflowActionDispatchState;
}

export interface WorkflowActionSessionRef {
  readonly sessionId: string;
  readonly title: string;
}

export interface WorkflowActionDispatchRequest {
  readonly itemId: string;
  readonly title: string;
  readonly prompt: string;
  readonly retry?: boolean;
  readonly runId?: string;
  readonly incidentId?: string;
}

export interface WorkflowActionDispatchResult {
  readonly status: "started" | "already-active";
  readonly item: WorkflowActionCenterItem;
}

export interface WorkflowNotificationOutboxItem {
  readonly id: string;
  readonly title: string;
  readonly destination: "email";
  readonly target: string;
  readonly preparedBy: string;
  readonly author?: string;
  readonly detailLevel: "generic" | "title-only" | "summary" | "detailed";
  readonly content: {
    readonly summary: string;
    readonly body: string;
    readonly incidentId?: string;
    readonly sourceArtifactKey?: string;
  };
  readonly approval: {
    readonly status: "pending" | "approved" | "rejected" | "sent" | "cancelled";
    readonly approvedBy?: string;
    readonly decidedAt?: number;
    readonly attempt?: number;
  };
}

export interface WorkflowCommandCenterProps {
  readonly workflowId: string;
  /** Recent run history (most-recent first), for timelines / status headers. */
  readonly runs: ReadonlyArray<WorkflowRunHistoryEntry>;
  readonly dashboard: WorkflowCommandCenterApi;
  /**
   * Host-provided navigation/launch actions. Optional because a renderer may be
   * previewed standalone; guard before calling. Lets the command center wire
   * "one-click" affordances (open a run's investigation, launch a seeded agent
   * session to work an action).
   */
  readonly actions?: WorkflowCommandCenterActions;
}

/** Host actions a command center can invoke for navigation / agent launch. */
export interface WorkflowCommandCenterActions {
  /** Open a specific run's detail page (which embeds its agent session + artifacts). */
  openRun(runId: string): void;
  /**
   * Create a NEW chat session seeded with `prompt` (e.g. "open a bug for
   * bucket X", "page on incident Y"). Hosts should record the linked session
   * for the action item and must not force immediate navigation.
   */
  launchSession(options: {
    title: string;
    prompt: string;
  }): Promise<WorkflowActionSessionRef | null>;
}

// ─── Chart spec (marshal-level shared visualization contract) ──────────────
//
// Agents emit charts as DATA (not React). A workflow's command center / run
// renderer draws a `ChartSpec` with a dependency-free SVG component, so any
// workflow can surface visualizations (recovery curves, incident volume, etc.)
// without shipping a charting library or runtime-generated code.

export type ChartKind = "line" | "area" | "bar";

export interface ChartPoint {
  /** X value: an ISO timestamp, a numeric value, or a category label. */
  readonly x: string | number;
  readonly y: number;
}

export interface ChartSeries {
  readonly name: string;
  readonly points: ReadonlyArray<ChartPoint>;
  /** Optional explicit color; renderers fall back to the theme accent/palette. */
  readonly color?: string;
}

export interface ChartSpec {
  readonly kind: ChartKind;
  readonly title?: string;
  readonly subtitle?: string;
  /** Treat x as time (ISO strings) for axis formatting. */
  readonly xIsTime?: boolean;
  readonly xLabel?: string;
  readonly yLabel?: string;
  /** Optional fixed y-domain; otherwise inferred from the data. */
  readonly yMin?: number;
  readonly yMax?: number;
  readonly series: ReadonlyArray<ChartSeries>;
  /** Optional reference markers (e.g. "mitigated", "deploy 26.05"). */
  readonly markers?: ReadonlyArray<{ x: string | number; label: string; color?: string }>;
}

export interface CommandCenterSpec {
  readonly workflowId: string;
  readonly render: (props: WorkflowCommandCenterProps) => unknown;
}

export interface CommandCenterDefinition extends CommandCenterSpec {
  readonly _brand?: "command-center"; // phantom — distinguishes from RendererDefinition
}

// ─── Event taxonomy (re-exported from common contract package shape) ─────────
//
// The on-disk event log is owned by `common/workflows-contract/events.ts`.
// The SDK exposes only a structural alias so workflow authors can read it
// from `ctx.emit` etc. without an `electron/` import.
export interface WorkflowEvent {
  readonly seq: number;
  readonly ts: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}
