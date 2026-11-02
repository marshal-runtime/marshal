import { randomUUID } from "node:crypto";

import type { SwarmRun } from "@marshal/swarm";
import type { SwarmRunCreateInput } from "@marshal/swarm";

import { createLogger } from "../../common/marshal-logger";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "./contracts";

const log = createLogger("SwarmDriver");
const RUN_ID_PREFIX = "owner.";

/** Thin invocation bridge to the Runtime-owned swarm source. */
export class SwarmDriver {
  private readonly activeMutations = new Map<string, Promise<SwarmRun>>();

  constructor(
    private readonly api: MarshalRuntimeApi,
    /** Fires for terminal runs — completed and failed (cancellation is terminal `failed`). */
    private readonly onRunSettled?: (
      scope: MarshalRuntimeScope,
      run: SwarmRun,
    ) => void | Promise<void>,
    /**
     * Fires instead of `onRunSettled` when a failed terminal state was reached
     * through an explicit `cancel` — the caller's abandon decision, which may
     * release the run's controller, unlike an ordinary failure where ownership
     * must stay recoverable.
     */
    private readonly onRunAbandoned?: (
      scope: MarshalRuntimeScope,
      run: SwarmRun,
    ) => void | Promise<void>,
  ) {}

  async start(scope: MarshalRuntimeScope, input: SwarmRunCreateInput): Promise<SwarmRun> {
    const runId = input.runId ?? createSwarmRunId(scope.sessionId);
    this.assertRunOwner(scope, runId);
    const run = await this.invokeRun(scope, "swarm.runs.create", {
      ...input,
      runId,
    });
    void this.drive(scope, run.runId).catch((error: unknown) => {
      log.error("Swarm drive failed.", { runId: run.runId }, error);
    });
    return run;
  }

  drive(scope: MarshalRuntimeScope, runId: string): Promise<SwarmRun> {
    this.assertRunOwner(scope, runId);
    return this.singleFlight("drive", runId, () =>
      this.settleInvoke(scope, runId, "swarm.runs.drive", { runId }),
    );
  }

  read(scope: MarshalRuntimeScope, runId: string): Promise<SwarmRun> {
    // The extension validates durable run membership for read-only traversal.
    return this.invokeRun(scope, "swarm.runs.get", { runId });
  }

  async cancel(scope: MarshalRuntimeScope, runId: string, reason: string): Promise<SwarmRun> {
    this.assertRunOwner(scope, runId);
    let run: SwarmRun;
    try {
      run = await this.invokeRun(scope, "swarm.runs.cancel", { runId, reason });
    } catch (error) {
      // Cancelling an already-terminal run may be rejected by the source; the
      // caller's abandon decision still stands when the persisted state reads
      // terminal, so read it back and honor it instead of failing the cancel.
      const current = await this.tryRead(scope, runId);
      if (!current || (current.state !== "failed" && current.state !== "completed")) throw error;
      run = current;
    }
    if (run.state === "failed") await this.onRunAbandoned?.(scope, run);
    else if (run.state === "completed") await this.onRunSettled?.(scope, run);
    return run;
  }

  pause(scope: MarshalRuntimeScope, runId: string, reason: string): Promise<SwarmRun> {
    this.assertRunOwner(scope, runId);
    return this.singleFlight("pause", runId, () =>
      this.invokeRun(scope, "swarm.runs.pause", { runId, reason }),
    );
  }

  async resume(scope: MarshalRuntimeScope, runId: string): Promise<SwarmRun> {
    this.assertRunOwner(scope, runId);
    const current = await this.invokeRun(scope, "swarm.runs.get", { runId });
    if (current.state !== "paused" && current.state !== "blocked") return current;
    await this.activeMutations.get(mutationKey("drive", runId))?.catch(() => undefined);
    const settled = await this.invokeRun(scope, "swarm.runs.get", { runId });
    if (settled.state !== "paused" && settled.state !== "blocked") return settled;
    return this.singleFlight("resume", runId, () =>
      this.settleInvoke(scope, runId, "swarm.runs.resume", { runId }),
    );
  }

  /** A mutation rejection can land after the executor persisted a terminal state; read it back so terminal runs never bypass settlement. */
  private async settleInvoke(
    scope: MarshalRuntimeScope,
    runId: string,
    capability: string,
    input: unknown,
  ): Promise<SwarmRun> {
    try {
      return await this.settle(scope, await this.invokeRun(scope, capability, input));
    } catch (error) {
      if (this.onRunSettled) {
        try {
          await this.settle(scope, await this.invokeRun(scope, "swarm.runs.get", { runId }));
        } catch (readError) {
          log.warn(
            "Terminal-state readback failed after a swarm mutation error.",
            { runId },
            readError,
          );
        }
      }
      throw error;
    }
  }

  private async settle(scope: MarshalRuntimeScope, run: SwarmRun): Promise<SwarmRun> {
    if (run.state === "completed" || run.state === "failed") {
      await this.onRunSettled?.(scope, run);
    }
    return run;
  }

  private async tryRead(scope: MarshalRuntimeScope, runId: string): Promise<SwarmRun | null> {
    try {
      return await this.invokeRun(scope, "swarm.runs.get", { runId });
    } catch (readError) {
      log.warn("Run readback failed after a rejected cancel.", { runId }, readError);
      return null;
    }
  }

  private assertRunOwner(scope: MarshalRuntimeScope, runId: string): void {
    if (parseSwarmRunOwnerSessionId(runId) !== scope.sessionId) {
      throw new Error(`Swarm run "${runId}" does not belong to session "${scope.sessionId}".`);
    }
  }

  private singleFlight(
    operation: "drive" | "pause" | "resume",
    runId: string,
    invoke: () => Promise<SwarmRun>,
  ): Promise<SwarmRun> {
    const key = mutationKey(operation, runId);
    const active = this.activeMutations.get(key);
    if (active) return active;
    const mutation = invoke().finally(() => {
      if (this.activeMutations.get(key) === mutation) this.activeMutations.delete(key);
    });
    this.activeMutations.set(key, mutation);
    return mutation;
  }

  private async invokeRun(
    scope: MarshalRuntimeScope,
    capability: string,
    input: unknown,
  ): Promise<SwarmRun> {
    const output = await this.invoke(scope, capability, input);
    if (!isRecord(output) || !isSwarmRun(output.run)) {
      throw new Error(`Marshal ${capability} returned an invalid run response.`);
    }
    return output.run;
  }

  private async invoke(
    scope: MarshalRuntimeScope,
    capability: string,
    input: unknown,
  ): Promise<unknown> {
    const result = await this.api.invoke({
      ...scope,
      capability,
      input,
      idempotencyKey: randomUUID(),
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.output;
  }
}

export function createSwarmRunId(sessionId: string, suffix: string = randomUUID()): string {
  const normalized = sessionId.trim();
  if (!normalized) throw new TypeError("Swarm owner session is required.");
  return `${RUN_ID_PREFIX}${Buffer.from(normalized, "utf8").toString("base64url")}.${suffix}`;
}

export function parseSwarmRunOwnerSessionId(runId: string): string {
  if (!runId.startsWith(RUN_ID_PREFIX)) {
    throw new Error(`Swarm run "${runId}" does not contain an owner session prefix.`);
  }
  const separator = runId.indexOf(".", RUN_ID_PREFIX.length);
  if (separator < 0) {
    throw new Error(`Swarm run "${runId}" does not contain an owner session prefix.`);
  }
  const encoded = runId.slice(RUN_ID_PREFIX.length, separator);
  const sessionId = Buffer.from(encoded, "base64url").toString("utf8");
  if (!sessionId || Buffer.from(sessionId, "utf8").toString("base64url") !== encoded) {
    throw new Error(`Swarm run "${runId}" has an invalid owner session prefix.`);
  }
  return sessionId;
}

function isSwarmRun(value: unknown): value is SwarmRun {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.objective === "string" &&
    (value.state === "running" ||
      value.state === "paused" ||
      value.state === "blocked" ||
      value.state === "completed" ||
      value.state === "failed") &&
    Array.isArray(value.tasks)
  );
}

function mutationKey(operation: string, runId: string): string {
  return `${operation}:${runId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
