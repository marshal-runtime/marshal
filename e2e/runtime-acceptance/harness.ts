import fs from "node:fs";
import path from "node:path";

import type { ElectronApplication, Page } from "@playwright/test";

import type {
  RuntimeUiAPI,
  RuntimeUiEvent,
  RuntimeUiScope,
} from "../../common/marshal-ipc-contract";
import type {
  RuntimeAcceptanceAPI,
  RuntimeAcceptanceApiResult,
  RuntimeAcceptanceResult,
  RuntimeAcceptanceScope,
} from "../../common/runtime-acceptance";

const ACCEPTANCE_OPERATION_TIMEOUT_MS = 30_000;

declare global {
  interface Window {
    runtimeAcceptanceAPI?: RuntimeAcceptanceAPI;
    runtimeUiAPI?: RuntimeUiAPI;
    __marshalUiXssProbe?: boolean;
  }
}

export type LiveStoryStatus = "PASS" | "FAIL" | "BLOCKED" | "EVIDENCE_CAPTURED";

export interface LiveStoryResult {
  readonly id: string;
  readonly status: LiveStoryStatus;
  readonly evidence: readonly string[];
  readonly bugId?: string;
  readonly reason?: string;
}

export interface LiveStoryProof {
  readonly proof: unknown;
  readonly context?: Partial<LiveStoryContext>;
  readonly actions?: readonly unknown[];
  readonly rawResultEnvelopes?: unknown;
  readonly assertions?: Readonly<Record<string, unknown>>;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly supportingEvidence?: readonly string[];
}

export interface LiveStoryContext {
  readonly processId: number;
  readonly userDataDirectory: string;
  readonly appDataDirectory: string;
}

type AcceptanceMethod = keyof RuntimeAcceptanceAPI;
type AcceptanceMethodArgs<K extends AcceptanceMethod> = RuntimeAcceptanceAPI[K] extends (
  ...args: infer Args
) => unknown
  ? Args
  : never;
type AcceptanceMethodResult<K extends AcceptanceMethod> = RuntimeAcceptanceAPI[K] extends (
  ...args: infer _Args
) => infer Result
  ? Awaited<Result>
  : never;
type AcceptanceMethodValue<K extends AcceptanceMethod> =
  AcceptanceMethodResult<K> extends RuntimeAcceptanceResult<infer Value> ? Value : never;
type RuntimeUiMethod = Exclude<keyof RuntimeUiAPI, "onEvent">;
type RuntimeUiMethodArgs<K extends RuntimeUiMethod> = RuntimeUiAPI[K] extends (
  ...args: infer Args
) => unknown
  ? Args
  : never;
type RuntimeUiMethodResult<K extends RuntimeUiMethod> = RuntimeUiAPI[K] extends (
  ...args: infer _Args
) => infer Result
  ? Awaited<Result>
  : never;

interface BugRecord {
  readonly id: string;
  readonly storyId: string;
  readonly kind: "product";
  readonly status: "open";
  readonly summary: string;
  readonly capturedAt: string;
}

export class LiveStoryRecorder {
  private readonly results: LiveStoryResult[] = [];
  private readonly bugs: BugRecord[] = [];

  constructor(
    private readonly evidenceRoot: string,
    private readonly context: LiveStoryContext,
  ) {}

  async run(storyId: string, action: () => Promise<LiveStoryProof>): Promise<void>;
  async run(
    storyId: string,
    evidenceClass: string,
    action: () => Promise<LiveStoryProof>,
  ): Promise<void>;
  async run(
    storyId: string,
    evidenceClassOrAction: string | (() => Promise<LiveStoryProof>),
    maybeAction?: () => Promise<LiveStoryProof>,
  ): Promise<void> {
    const evidenceClass =
      typeof evidenceClassOrAction === "string" ? evidenceClassOrAction : "LIVE-ELECTRON";
    const action =
      typeof evidenceClassOrAction === "function" ? evidenceClassOrAction : maybeAction;
    if (!action) throw new Error(`Live story action is required: ${storyId}`);
    await this.record(storyId, evidenceClass, "PASS", action);
  }

  async capture(
    storyId: string,
    evidenceClass: string,
    action: () => Promise<LiveStoryProof>,
  ): Promise<void> {
    await this.record(storyId, evidenceClass, "EVIDENCE_CAPTURED", action);
  }

  private async record(
    storyId: string,
    evidenceClass: string,
    successStatus: Extract<LiveStoryStatus, "PASS" | "EVIDENCE_CAPTURED">,
    action: () => Promise<LiveStoryProof>,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    let capturedResult: LiveStoryProof | undefined;
    try {
      const result = await action();
      capturedResult = result;
      const failedAssertions = assertionFailures(result);
      if (failedAssertions.length > 0) {
        throw new Error(
          `Acceptance assertions failed for ${storyId}: ${failedAssertions.join(", ")}`,
        );
      }
      const completedAt = new Date().toISOString();
      const context = { ...this.context, ...result.context };
      const storyPath = this.writeStory(storyId, {
        stableId: storyId,
        status: successStatus,
        startedAt,
        completedAt,
        evidenceClass,
        processId: context.processId,
        userDataDirectory: context.userDataDirectory,
        appDataDirectory: context.appDataDirectory,
        actions: result.actions ?? [],
        rawResultEnvelopes: result.rawResultEnvelopes ?? result.proof,
        assertions: result.assertions ?? { proof: result.proof },
        artifactLinks: result.supportingEvidence ?? [],
        proof: result.proof,
        ...(result.evidence ? { evidence: result.evidence } : {}),
        supportingEvidence: result.supportingEvidence ?? [],
      });
      this.results.push({ id: storyId, status: successStatus, evidence: [storyPath] });
    } catch (error) {
      const bugId = this.nextBugId();
      const reason = errorMessage(error);
      const completedAt = new Date().toISOString();
      const context = { ...this.context, ...capturedResult?.context };
      const storyPath = this.writeStory(storyId, {
        stableId: storyId,
        status: "FAIL",
        startedAt,
        completedAt,
        evidenceClass,
        processId: context.processId,
        userDataDirectory: context.userDataDirectory,
        appDataDirectory: context.appDataDirectory,
        bugId,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: reason,
          stack: error instanceof Error ? error.stack : undefined,
        },
        ...(capturedResult
          ? {
              actions: capturedResult.actions ?? [],
              rawResultEnvelopes: capturedResult.rawResultEnvelopes ?? capturedResult.proof,
              assertions: capturedResult.assertions ?? { proof: capturedResult.proof },
              artifactLinks: capturedResult.supportingEvidence ?? [],
              proof: capturedResult.proof,
              ...(capturedResult.evidence ? { evidence: capturedResult.evidence } : {}),
              supportingEvidence: capturedResult.supportingEvidence ?? [],
            }
          : {}),
      });
      this.bugs.push({
        id: bugId,
        storyId,
        kind: "product",
        status: "open",
        summary: reason,
        capturedAt: completedAt,
      });
      this.results.push({
        id: storyId,
        status: "FAIL",
        evidence: [storyPath],
        bugId,
        reason,
      });
    }
  }

  block(storyId: string, evidenceClass: string, reason: string): void {
    const capturedAt = new Date().toISOString();
    const storyPath = this.writeStory(storyId, {
      stableId: storyId,
      status: "BLOCKED",
      startedAt: capturedAt,
      completedAt: capturedAt,
      evidenceClass,
      processId: this.context.processId,
      userDataDirectory: this.context.userDataDirectory,
      appDataDirectory: this.context.appDataDirectory,
      reason,
    });
    this.results.push({ id: storyId, status: "BLOCKED", evidence: [storyPath], reason });
  }

  writeSupporting(relativePath: string, value: unknown): string {
    const target = path.join(this.evidenceRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value, null, 2));
    return normalizeEvidencePath(path.relative(this.evidenceRoot, target));
  }

  finalize(): {
    readonly stories: readonly LiveStoryResult[];
    readonly bugs: readonly BugRecord[];
  } {
    const priorResults = record(
      readJson(path.join(this.evidenceRoot, "stories", "live-story-results.json")),
    );
    const priorBugs = readJson(path.join(this.evidenceRoot, "product-bugs.json"));
    const stories = mergeById(
      Array.isArray(priorResults?.stories) ? priorResults.stories.filter(isLiveStoryResult) : [],
      this.results,
    );
    const bugs = mergeById(
      Array.isArray(priorBugs) ? priorBugs.filter(isBugRecord) : [],
      this.bugs,
    );
    this.writeSupporting(path.join("stories", "live-story-results.json"), { stories });
    this.writeSupporting("product-bugs.json", bugs);
    return { stories, bugs };
  }

  private writeStory(storyId: string, value: unknown): string {
    return this.writeSupporting(path.join("stories", `${storyId}.json`), value);
  }

  private nextBugId(): string {
    const prior = readJson(path.join(this.evidenceRoot, "product-bugs.json"));
    const numbers = [...(Array.isArray(prior) ? prior.filter(isBugRecord) : []), ...this.bugs]
      .map((bug) => /^MRT-BUG-(\d+)$/.exec(bug.id))
      .flatMap((match) => (match ? [Number(match[1])] : []));
    const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
    return `MRT-BUG-${String(next).padStart(3, "0")}`;
  }
}

function readJson(filePath: string): Record<string, unknown> | readonly unknown[] | null {
  if (!fs.existsSync(filePath)) return null;
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return isRecord(parsed) || Array.isArray(parsed) ? parsed : null;
}

function mergeById<T extends { readonly id: string }>(
  prior: readonly T[],
  current: readonly T[],
): readonly T[] {
  const merged = new Map<string, T>();
  for (const value of prior) merged.set(value.id, value);
  for (const value of current) merged.set(value.id, value);
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function isLiveStoryResult(value: unknown): value is LiveStoryResult {
  if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.evidence)) {
    return false;
  }
  return ["PASS", "FAIL", "BLOCKED", "EVIDENCE_CAPTURED"].includes(String(value.status));
}

function isBugRecord(value: unknown): value is BugRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.storyId === "string" &&
    value.kind === "product" &&
    value.status === "open" &&
    typeof value.summary === "string" &&
    typeof value.capturedAt === "string"
  );
}

export class RuntimeAcceptanceClient {
  constructor(
    readonly app: ElectronApplication,
    readonly page: Page,
    readonly scope: RuntimeAcceptanceScope,
  ) {}

  async acceptance<K extends AcceptanceMethod>(
    method: K,
    ...args: AcceptanceMethodArgs<K>
  ): Promise<RuntimeAcceptanceResult<AcceptanceMethodValue<K>>> {
    const result: unknown = await withTimeout(
      this.page.evaluate(
        async ({ methodName, methodArgs }) => {
          const api = window.runtimeAcceptanceAPI;
          if (!api) throw new Error("Marshal Runtime acceptance preload is unavailable.");
          const operation = Reflect.get(api, methodName);
          if (typeof operation !== "function") {
            throw new Error(`Marshal Runtime acceptance operation is unavailable: ${methodName}`);
          }
          const value: unknown = await Reflect.apply(operation, api, methodArgs);
          return value;
        },
        { methodName: method, methodArgs: args },
      ),
      `Marshal Runtime acceptance operation timed out: ${method}`,
    );
    assertRuntimeAcceptanceResult<AcceptanceMethodValue<K>>(result, method);
    return result;
  }

  async value<K extends AcceptanceMethod>(
    method: K,
    ...args: AcceptanceMethodArgs<K>
  ): Promise<AcceptanceMethodValue<K>> {
    return unwrap(await this.acceptance(method, ...args));
  }

  invoke(
    capability: string,
    input: unknown,
    idempotencyKey: string,
    options: {
      readonly scope?: RuntimeAcceptanceScope;
      readonly abort?: Parameters<RuntimeAcceptanceAPI["invoke"]>[0]["abort"];
    } = {},
  ) {
    return this.value("invoke", {
      ...(options.scope ?? this.scope),
      capability,
      input,
      idempotencyKey,
      ...(options.abort ? { abort: options.abort } : {}),
    });
  }

  search(
    request: Omit<Parameters<RuntimeAcceptanceAPI["search"]>[0], keyof RuntimeAcceptanceScope>,
    scope: RuntimeAcceptanceScope = this.scope,
  ) {
    return this.value("search", { ...scope, ...request });
  }

  async ui<K extends RuntimeUiMethod>(
    method: K,
    ...args: RuntimeUiMethodArgs<K>
  ): Promise<RuntimeUiMethodResult<K>> {
    const result: unknown = await withTimeout(
      this.page.evaluate(
        async ({ methodName, methodArgs }) => {
          const api = window.runtimeUiAPI;
          if (!api) throw new Error("Marshal Runtime UI preload is unavailable.");
          const operation = Reflect.get(api, methodName);
          if (typeof operation !== "function") {
            throw new Error(`Marshal Runtime UI operation is unavailable: ${methodName}`);
          }
          const value: unknown = await Reflect.apply(operation, api, methodArgs);
          return value;
        },
        { methodName: method, methodArgs: args },
      ),
      `Marshal Runtime UI operation timed out: ${method}`,
    );
    assertRuntimeUiMethodResult<K>(result, method);
    return result;
  }

  async captureUiEvents(scope: RuntimeUiScope): Promise<{
    readonly events: readonly RuntimeUiEvent[];
    readonly unsubscribe: () => Promise<void>;
  }> {
    await withTimeout(
      this.page.evaluate(async (targetScope) => {
        const api = window.runtimeUiAPI;
        if (!api) throw new Error("Marshal Runtime UI preload is unavailable.");
        const store = (window as Window & { __runtimeAcceptanceUiEvents?: RuntimeUiEvent[] })
          .__runtimeAcceptanceUiEvents;
        if (store) store.length = 0;
        else {
          (
            window as Window & { __runtimeAcceptanceUiEvents?: RuntimeUiEvent[] }
          ).__runtimeAcceptanceUiEvents = [];
        }
        const disposer = api.onEvent((event: RuntimeUiEvent) => {
          (
            window as Window & {
              __runtimeAcceptanceUiEvents?: RuntimeUiEvent[];
            }
          ).__runtimeAcceptanceUiEvents?.push(event);
        });
        (
          window as Window & {
            __runtimeAcceptanceUiEventDisposer?: () => void;
          }
        ).__runtimeAcceptanceUiEventDisposer = disposer;
        const result = await api.subscribe(targetScope);
        if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
      }, scope),
      "Marshal Runtime UI event subscription timed out",
    );
    return {
      events: await this.readUiEvents(),
      unsubscribe: async () => {
        await withTimeout(
          this.page.evaluate(async () => {
            (
              window as Window & {
                __runtimeAcceptanceUiEventDisposer?: () => void;
              }
            ).__runtimeAcceptanceUiEventDisposer?.();
            await window.runtimeUiAPI?.unsubscribe();
          }),
          "Marshal Runtime UI event unsubscription timed out",
        );
      },
    };
  }

  readUiEvents(): Promise<readonly RuntimeUiEvent[]> {
    return this.page.evaluate(
      () =>
        [
          ...((window as Window & { __runtimeAcceptanceUiEvents?: RuntimeUiEvent[] })
            .__runtimeAcceptanceUiEvents ?? []),
        ] as readonly RuntimeUiEvent[],
    );
  }
}

export function unwrap<T>(result: RuntimeAcceptanceResult<T>): T {
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? Object.fromEntries(Object.entries(value)) : {};
}

export function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function output(value: unknown): Record<string, unknown> {
  return record(record(record(value).value).output);
}

export function requireOk<T>(
  value: RuntimeAcceptanceApiResult<T>,
): Extract<RuntimeAcceptanceApiResult<T>, { readonly ok: true }> & T;
export function requireOk(value: unknown): Record<string, unknown>;
export function requireOk(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (result.ok !== true) {
    const error = record(result.error);
    throw new Error(
      `${typeof error.code === "string" ? error.code : "operation-failed"}: ${
        typeof error.message === "string" ? error.message : "Runtime operation failed."
      }`,
    );
  }
  return { ...result, ...record(result.value) };
}

export function resultErrorCode(value: unknown): string | null {
  const result = record(value);
  const error = record(result.error);
  return result.ok === false && typeof error.code === "string" ? error.code : null;
}

function normalizeEvidencePath(value: string): string {
  return value.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function assertionFailures(value: unknown, pathPrefix = "result"): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const failures: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const assertionPath = `${pathPrefix}.${key}`;
    if (key === "assertions" && child && typeof child === "object" && !Array.isArray(child)) {
      for (const [assertion, outcome] of Object.entries(child)) {
        if (outcome !== true) failures.push(`${assertionPath}.${assertion}`);
      }
      continue;
    }
    failures.push(...assertionFailures(child, assertionPath));
  }
  return failures;
}

async function withTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${message} after ${ACCEPTANCE_OPERATION_TIMEOUT_MS}ms`)),
          ACCEPTANCE_OPERATION_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRuntimeAcceptanceResult<T>(
  value: unknown,
  method: string,
): asserts value is RuntimeAcceptanceResult<T> {
  if (!isRecord(value) || typeof value.success !== "boolean") {
    throw new Error(`Marshal Runtime acceptance operation returned an invalid envelope: ${method}`);
  }
  if (value.success) {
    if ("value" in value) return;
  } else {
    const error = record(value.error);
    if (typeof error.code === "string" && typeof error.message === "string") return;
  }
  throw new Error(`Marshal Runtime acceptance operation returned an invalid envelope: ${method}`);
}

function assertRuntimeUiMethodResult<K extends RuntimeUiMethod>(
  value: unknown,
  method: K,
): asserts value is RuntimeUiMethodResult<K> {
  if (!isRecord(value) || typeof value.success !== "boolean") {
    throw new Error(`Marshal Runtime UI operation returned an invalid envelope: ${method}`);
  }
  if (value.success) return;
  const error = record(value.error);
  if (typeof error.code === "string" && typeof error.message === "string") return;
  throw new Error(`Marshal Runtime UI operation returned an invalid envelope: ${method}`);
}
