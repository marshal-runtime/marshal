import { createHash, randomUUID } from "node:crypto";

import type { InvocationContext } from "@marshal/runtime";

import type { AutomationData } from "../../common/marshal-ipc-contract";
import type { AutomationActiveExecution, AutomationManager } from "../automations/manager";
import type { MarshalRuntimeScope } from "./contracts";
import {
  normalizeSelectedSessionOwner,
  type SelectedSessionDeliveryService,
  type SelectedSessionOwner,
  type SelectedSessionReceipt,
  type SelectedSessionTarget,
} from "./selected-session-delivery";

export interface ApplicationJobInvocation {
  readonly invocationId: string;
  readonly jobId: string;
  readonly owner: SelectedSessionOwner;
  readonly capabilities: ReadonlySet<string>;
  readonly executionScope: MarshalRuntimeScope;
  readonly isActive: () => Promise<boolean>;
}

export interface ApplicationJobOptions {
  readonly automations: Pick<
    AutomationManager,
    "list" | "setApplicationJobMarker" | "getActiveExecution"
  >;
  readonly delivery: SelectedSessionDeliveryService;
  readonly getSession: (
    sessionId: string,
  ) => Promise<(SelectedSessionTarget & { source?: string; automationId?: string }) | null>;
  readonly isOwnerActive: (owner: SelectedSessionOwner) => boolean | Promise<boolean>;
  /** Check actual current publication ownership, not a name-prefix guess. */
  readonly isCapabilityOwned: (
    owner: SelectedSessionOwner,
    capability: string,
  ) => boolean | Promise<boolean>;
  readonly invoke: (
    authority: ApplicationJobInvocation,
    capability: string,
    input: unknown,
    context: InvocationContext,
  ) => Promise<unknown>;
}

export interface ApplicationJobStatus {
  readonly jobKey: string;
  readonly jobId?: string;
  readonly automationId?: string;
  readonly targetSessionId?: string;
  readonly state: "armed" | "disarmed" | "suspended-restart" | "suspended-changed";
}
interface Job {
  readonly id: string;
  readonly owner: SelectedSessionOwner;
  readonly ownerKey: string;
  readonly jobKey: string;
  readonly automationId: string;
  readonly grantId: string;
  readonly snapshot: string;
  readonly target: SelectedSessionTarget;
  readonly capabilities: readonly string[];
}
interface ActiveInvocation {
  readonly job: Job;
  readonly execution: AutomationActiveExecution;
  readonly signal?: AbortSignal;
}
const DELIVERY_CAPABILITIES = [
  "marshal.session.delivery.send",
  "marshal.session.delivery.read",
  "marshal.session.delivery.cancel",
  "marshal.application.job.status",
  "marshal.application.job.disarm",
];

/** Process-local arm authority, with non-secret restart markers persisted by AutomationManager. */
export class RuntimeApplicationJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly calls = new Map<string, ActiveInvocation>();
  private readonly pendingArms = new Set<string>();
  private readonly applicationEpochs = new Map<string, number>();
  private readonly jobEpochs = new Map<string, number>();

  constructor(private readonly options: ApplicationJobOptions) {}

  async arm(ownerValue: SelectedSessionOwner, input: unknown): Promise<ApplicationJobStatus> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    const request = object(input, ["jobKey", "automationId", "grantId", "capabilities"]);
    const jobKey = id(request.jobKey);
    const automationId = id(request.automationId);
    const grantId = id(request.grantId);
    if (
      !Array.isArray(request.capabilities) ||
      !request.capabilities.length ||
      request.capabilities.length > 8
    )
      throw denied("Declare one to eight application-owned job capabilities.");
    const capabilities = [...new Set(request.capabilities.map(id))].sort();
    const key = applicationJobOwnerKey(owner);
    const applicationKey = `${owner.extensionId}:${owner.applicationId}`;
    const epoch = this.applicationEpochs.get(applicationKey) ?? 0;
    const lockKey = `${key}:${jobKey}`;
    const jobEpoch = this.jobEpochs.get(lockKey) ?? 0;
    if (this.pendingArms.has(lockKey)) throw denied("This application job is already being armed.");
    this.pendingArms.add(lockKey);
    try {
      if (!(await this.options.isOwnerActive(owner)))
        throw denied("Application owner is inactive.");
      const owned = await Promise.all(
        capabilities.map(
          async (capability) =>
            !/^(marshal\.|runtime\.|swarm\.|ui\.)/.test(capability) &&
            (await this.options.isCapabilityOwned(owner, capability)),
        ),
      );
      if (owned.some((allowed) => !allowed))
        throw denied("Job entry capabilities must belong to the active application publication.");
      const target = await this.options.delivery.resolveGrant(owner, grantId);
      const automation = this.options.automations.list().find((entry) => entry.id === automationId);
      if (
        !automation ||
        automation.triggerType !== "schedule" ||
        automation.targetSessionId ||
        automation.steps.length !== 1
      )
        throw denied("Use a dedicated one-step scheduled automation without targetSessionId.");
      if (
        automation.applicationJob &&
        (automation.applicationJob.ownerKey !== key || automation.applicationJob.jobKey !== jobKey)
      )
        throw denied("Automation is bound to a different application job.");
      const armSnapshot = digest(automation);
      if (!(await this.isCoordinatorPinValid(automation, target)))
        throw denied("Pinned coordinator must belong to this automation in the selected runtime.");
      const prior = [...this.jobs.values()].find(
        (entry) => entry.ownerKey === key && entry.jobKey === jobKey,
      );
      if (prior) {
        if (
          prior.automationId === automationId &&
          same(prior.target, target) &&
          same(prior.capabilities, capabilities) &&
          (await this.isArmed(prior.id))
        )
          return status(prior, "armed");
        throw denied("Disarm the existing job before changing its binding.");
      }
      // The marker is non-secret; possession or edits never recreate this in-memory record.
      const jobId = randomUUID();
      if (
        epoch !== (this.applicationEpochs.get(applicationKey) ?? 0) ||
        jobEpoch !== (this.jobEpochs.get(lockKey) ?? 0)
      )
        throw denied("Application was revoked while arming.");
      if (this.jobs.size >= 500) throw denied("Too many armed application jobs.");
      const latest = this.options.automations.list().find((entry) => entry.id === automationId);
      if (!latest || digest(latest) !== armSnapshot)
        throw denied("Automation changed while its arm-time session binding was being checked.");
      const armed = this.options.automations.setApplicationJobMarker(
        automationId,
        { ownerKey: key, jobKey, jobId, state: "armed" },
        true,
      );
      const job: Job = {
        id: jobId,
        owner,
        ownerKey: key,
        jobKey,
        automationId,
        grantId,
        target,
        capabilities,
        snapshot: automationSnapshot(armed),
      };
      this.jobs.set(jobId, job);
      if (!(await this.isArmed(jobId))) {
        await this.disarm(owner, { jobKey });
        throw denied("Application or automation changed while arming.");
      }
      return status(job, "armed");
    } finally {
      this.pendingArms.delete(lockKey);
    }
  }

  async status(ownerValue: SelectedSessionOwner, input: unknown): Promise<ApplicationJobStatus> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    const jobKey = id(object(input, ["jobKey"]).jobKey);
    const key = applicationJobOwnerKey(owner);
    const job = [...this.jobs.values()].find(
      (entry) => entry.ownerKey === key && entry.jobKey === jobKey,
    );
    if (job) return status(job, (await this.isArmed(job.id)) ? "armed" : "suspended-changed");
    const automation = this.options.automations
      .list()
      .find(
        (entry) => entry.applicationJob?.ownerKey === key && entry.applicationJob.jobKey === jobKey,
      );
    return {
      jobKey,
      ...(automation
        ? { jobId: automation.applicationJob?.jobId, automationId: automation.id }
        : {}),
      state:
        automation?.applicationJob?.state === "disarmed" || !automation
          ? "disarmed"
          : "suspended-restart",
    };
  }

  async disarm(ownerValue: SelectedSessionOwner, input: unknown): Promise<ApplicationJobStatus> {
    const owner = normalizeSelectedSessionOwner(ownerValue);
    const jobKey = id(object(input, ["jobKey"]).jobKey);
    const key = applicationJobOwnerKey(owner);
    const lockKey = `${key}:${jobKey}`;
    this.jobEpochs.set(lockKey, (this.jobEpochs.get(lockKey) ?? 0) + 1);
    const matching = [...this.jobs.values()].filter(
      (entry) => entry.ownerKey === key && entry.jobKey === jobKey,
    );
    // Revoke before awaiting cancellation; in-flight dispatch checks immediately fail closed.
    for (const job of matching) this.jobs.delete(job.id);
    for (const automation of this.options.automations.list()) {
      if (
        automation.applicationJob?.ownerKey === key &&
        automation.applicationJob.jobKey === jobKey
      )
        this.options.automations.setApplicationJobMarker(
          automation.id,
          { ...automation.applicationJob, state: "disarmed" },
          false,
        );
    }
    await Promise.all(matching.map((job) => this.options.delivery.revokeJob(job.id)));
    return this.status(owner, { jobKey });
  }

  async revokeApplication(identity: { extensionId: string; applicationId: string }): Promise<void> {
    const key = `${identity.extensionId}:${identity.applicationId}`;
    this.applicationEpochs.set(key, (this.applicationEpochs.get(key) ?? 0) + 1);
    const matching = [...this.jobs.values()].filter(
      (job) =>
        job.owner.extensionId === identity.extensionId &&
        job.owner.applicationId === identity.applicationId,
    );
    await Promise.all(matching.map((job) => this.disarm(job.owner, { jobKey: job.jobKey })));
  }

  async isArmed(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || !(await this.options.isOwnerActive(job.owner))) return false;
    const automation = this.options.automations
      .list()
      .find((entry) => entry.id === job.automationId);
    if (
      !automation?.enabled ||
      automation.applicationJob?.jobId !== jobId ||
      automation.applicationJob.state !== "armed" ||
      automationSnapshot(automation) !== job.snapshot
    )
      return false;
    const target = await this.options.getSession(job.target.sessionId);
    if (!target || !same(targetIdentity(target), job.target)) return false;
    if (!(await this.isCoordinatorPinValid(automation, job.target))) return false;
    const owned = await Promise.all(
      job.capabilities.map(async (capability) =>
        this.options.isCapabilityOwned(job.owner, capability),
      ),
    );
    if (owned.some((allowed) => !allowed)) return false;
    const latest = this.options.automations.list().find((entry) => entry.id === job.automationId);
    return this.jobs.get(jobId) === job && !!latest && digest(latest) === digest(automation);
  }

  async isDeliveryActive(
    jobId: string,
    owner: SelectedSessionOwner,
    target: SelectedSessionTarget,
  ): Promise<boolean> {
    const job = this.jobs.get(jobId);
    return (
      !!job &&
      job.ownerKey === applicationJobOwnerKey(owner) &&
      same(job.target, target) &&
      (await this.isArmed(jobId))
    );
  }

  /** Called only after the normal runtime has supplied its authenticated native session scope. */
  async invoke(input: unknown, context: InvocationContext): Promise<unknown> {
    const request = object(input, ["jobId", "jobKey", "capability", "input"]);
    const capability = id(request.capability);
    const sessionId = context.scope?.sessionId;
    const execution =
      typeof sessionId === "string"
        ? this.options.automations.getActiveExecution(sessionId)
        : undefined;
    if ((request.jobId === undefined) === (request.jobKey === undefined))
      throw denied("Supply exactly one of jobId or jobKey.");
    const job =
      request.jobId !== undefined
        ? this.jobs.get(id(request.jobId))
        : [...this.jobs.values()].find(
            (entry) =>
              entry.automationId === execution?.automationId && entry.jobKey === id(request.jobKey),
          );
    if (
      !job ||
      !execution ||
      execution.automationId !== job.automationId ||
      !job.capabilities.includes(capability)
    )
      throw denied("Only the bound automation's current native step can invoke this job.");
    const invocationId = randomUUID();
    const call: ActiveInvocation = {
      job,
      execution,
      ...(context.signal instanceof AbortSignal ? { signal: context.signal } : {}),
    };
    if (!(await this.isCallActive(call)))
      throw denied("Application job execution is no longer active.");
    if (JSON.stringify(request.input ?? null).length > 65_536)
      throw denied("Job input is too large.");
    const session = await this.options.getSession(execution.sessionId);
    if (!session) throw denied("Coordinator session disappeared.");
    if (this.calls.size >= 100) throw denied("Too many concurrent application job invocations.");
    this.calls.set(invocationId, call);
    try {
      return await this.options.invoke(
        {
          invocationId,
          jobId: job.id,
          owner: job.owner,
          capabilities: new Set([...job.capabilities, ...DELIVERY_CAPABILITIES]),
          executionScope: { sessionId: execution.sessionId, workspaceName: session.workspaceName },
          isActive: async () =>
            this.calls.get(invocationId) === call && (await this.isCallActive(call)),
        },
        capability,
        request.input,
        context,
      );
    } finally {
      this.calls.delete(invocationId);
    }
  }

  /** Authenticated background application calls route H3 here, preserving job/target/request boundaries. */
  async control(
    invocationId: string,
    operation: "status" | "disarm",
    input: unknown,
  ): Promise<ApplicationJobStatus> {
    const call = this.calls.get(invocationId);
    const request = object(input, ["jobKey"]);
    if (!call || !(await this.isCallActive(call)) || id(request.jobKey) !== call.job.jobKey)
      throw denied(
        "Only the current background invocation's own job may be inspected or disarmed.",
      );
    return operation === "status"
      ? this.status(call.job.owner, request)
      : this.disarm(call.job.owner, request);
  }

  /** Authenticated background application calls route H3 here, preserving job/target/request boundaries. */
  async delivery(
    invocationId: string,
    name: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<SelectedSessionReceipt> {
    signal?.throwIfAborted();
    const call = this.calls.get(invocationId);
    if (!call || !(await this.isCallActive(call)))
      throw denied("Background application invocation has expired.");
    const operation = name.replace(/^marshal\.session\.delivery\./, "");
    const request = object(
      input,
      operation === "send"
        ? ["grantId", "requestId", "message", "context", "attachmentHandles"]
        : operation === "read"
          ? ["requestId", "afterCursor", "timeoutMs"]
          : ["requestId"],
    );
    const requestId = id(request.requestId);
    const scopedRequestId = `job:${digest([call.job.ownerKey, call.job.jobKey, requestId])}`;
    let receipt: SelectedSessionReceipt;
    if (operation === "send") {
      // The arm-time picker grant identifies the bound target even after its ordinary UI TTL expires.
      if (request.grantId !== undefined && request.grantId !== call.job.grantId)
        throw denied("Delivery grant differs from the job's arm-time selection.");
      const grant = await this.options.delivery.grant(call.job.owner, call.job.target.sessionId);
      try {
        if (!(await this.isCallActive(call)))
          throw denied("Application job changed before delivery.");
        receipt = await this.options.delivery.send(
          call.job.owner,
          { ...request, grantId: grant.grantId, requestId: scopedRequestId },
          signal,
          call.job.id,
        );
      } finally {
        await this.options.delivery.revokeGrant(call.job.owner, grant.grantId);
      }
    } else if (operation === "read") {
      const timeoutMs = request.timeoutMs ?? 0;
      if (
        typeof timeoutMs !== "number" ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 0 ||
        timeoutMs > 30_000 ||
        (request.afterCursor !== undefined &&
          (typeof request.afterCursor !== "string" || request.afterCursor.length > 1024))
      )
        throw denied("Invalid delivery cursor or timeout.");
      receipt = await this.options.delivery.wait(
        call.job.owner,
        scopedRequestId,
        typeof request.afterCursor === "string" ? request.afterCursor : undefined,
        timeoutMs,
        signal,
      );
    } else if (operation === "cancel") {
      receipt = await this.options.delivery.cancel(call.job.owner, scopedRequestId);
    } else throw denied("Unknown background delivery operation.");
    return { ...receipt, requestId };
  }

  private async isCallActive(call: ActiveInvocation): Promise<boolean> {
    if (call.signal?.aborted) return false;
    if (!(await this.isArmed(call.job.id))) return false;
    const execution = this.options.automations.getActiveExecution(call.execution.sessionId);
    if (!execution || !same(execution, call.execution)) return false;
    const session = await this.options.getSession(execution.sessionId);
    return (
      !!session &&
      session.source === "automation" &&
      session.automationId === call.job.automationId &&
      session.sessionId !== call.job.target.sessionId &&
      session.runtimeId === call.job.target.runtimeId
    );
  }

  private async isCoordinatorPinValid(
    automation: AutomationData,
    target: SelectedSessionTarget,
  ): Promise<boolean> {
    const pinned = automation.pinnedSessionId?.trim();
    if (!pinned) return true;
    if (pinned === target.sessionId) return false;
    const session = await this.options.getSession(pinned);
    // A deleted pin is safely replaced by AutomationManager with a new automation-owned session.
    return (
      session === null ||
      (session.sessionId === pinned &&
        session.source === "automation" &&
        session.automationId === automation.id &&
        session.runtimeId === target.runtimeId)
    );
  }
}

function status(job: Job, state: ApplicationJobStatus["state"]): ApplicationJobStatus {
  return {
    jobKey: job.jobKey,
    jobId: job.id,
    automationId: job.automationId,
    targetSessionId: job.target.sessionId,
    state,
  };
}
export function applicationJobOwnerKey(owner: SelectedSessionOwner): string {
  return digest(normalizeSelectedSessionOwner(owner));
}
function automationSnapshot(automation: AutomationData): string {
  const { applicationJob: _job, pinnedSessionId: _pinned, ...configuration } = automation;
  return digest(configuration);
}
function targetIdentity(target: SelectedSessionTarget): SelectedSessionTarget {
  return {
    sessionId: target.sessionId,
    workspaceName: target.workspaceName,
    runtimeId: target.runtimeId,
  };
}
function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]),
  );
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw denied("Expected an identifier of 1 to 256 characters.");
  return value;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw denied("Expected an object.");
  const result = Object.fromEntries(Object.entries(value));
  if (Object.keys(result).some((key) => !keys.includes(key)))
    throw denied("Unexpected application-job property.");
  return result;
}
function denied(message: string): Error {
  return Object.assign(new Error(message), { code: "permission_denied" });
}
