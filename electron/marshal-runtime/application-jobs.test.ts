import type { InvocationContext } from "@marshal/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentMessageOutbox } from "../agent-message-outbox";
import type { Automation } from "../automations";
import type { AutomationActiveExecution } from "../automations/manager";
import { createApplicationJobProvider } from "./application-job-provider";
import {
  RuntimeApplicationJobs,
  type ApplicationJobOptions,
  type ApplicationJobInvocation,
} from "./application-jobs";
import {
  SelectedSessionDeliveryService,
  type SelectedSessionOwner,
} from "./selected-session-delivery";

const owner: SelectedSessionOwner = {
  extensionId: "reviews",
  applicationId: "pr",
  applicationScope: "user",
  workspaceName: "marshal",
};
const target = { sessionId: "driver", workspaceName: "repo", runtimeId: "claude" };
const coordinator = {
  sessionId: "coordinator",
  workspaceName: "repo",
  runtimeId: "claude",
  source: "automation",
  automationId: "automation-1",
};
const context: InvocationContext = {
  principal: { id: "native", kind: "agent" },
  scope: { sessionId: "coordinator" },
};
const queues: AgentMessageOutbox[] = [];
afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.shutdown()));
});

async function harness(invoke?: ApplicationJobOptions["invoke"]) {
  let active = true;
  let execution: AutomationActiveExecution | undefined = {
    automationId: "automation-1",
    runId: "run-1",
    stepId: "main",
    sessionId: "coordinator",
    clientMessageId: "native-user-1",
  };
  let automation: Automation = {
    id: "automation-1",
    name: "Review checks",
    enabled: false,
    triggerType: "schedule",
    createdAt: "now",
    updatedAt: "now",
    steps: [{ id: "main", label: "Wake", prompt: "Invoke review.wake for jobKey pr-1" }],
    schedule: {
      kind: "interval",
      naturalLanguage: "every 10 minutes",
      days: [0, 1, 2, 3, 4, 5, 6],
      hour: 0,
      minute: 0,
      anchor: { hour: 0, minute: 0 },
      intervalMinutes: 10,
    },
  };
  let jobs: RuntimeApplicationJobs;
  const outbox: AgentMessageOutbox = new AgentMessageOutbox({
    persistence: { load: async () => null, save: async () => {} },
    deliver: (message, control) => delivery.deliver(message, control),
    retryDelayMs: 1,
  });
  queues.push(outbox);
  const sendAndCollect = vi
    .fn<
      ConstructorParameters<typeof SelectedSessionDeliveryService>[0]["sessions"]["sendAndCollect"]
    >()
    .mockImplementation(async (_message, _timeout, events, _sessionId, _attachments, options) => {
      await options?.onBackendDispatchStarting?.();
      await options?.onBackendDelivered?.();
      events?.({ type: "turn:text-delta", delta: "native response" });
      return { kind: "ok", text: "native response" };
    });
  const getSession = vi.fn<ApplicationJobOptions["getSession"]>(async (sessionId) =>
    sessionId === "driver" ? target : sessionId === "coordinator" ? coordinator : null,
  );
  const delivery: SelectedSessionDeliveryService = new SelectedSessionDeliveryService({
    outbox,
    sessions: { sendAndCollect, isSessionBusy: () => false },
    getTarget: getSession,
    currentRuntimeId: () => "claude",
    isOwnerActive: () => active,
    isJobActive: (jobId, jobOwner, jobTarget) => jobs.isDeliveryActive(jobId, jobOwner, jobTarget),
  });
  const invokeFn = vi.fn<ApplicationJobOptions["invoke"]>(invoke ?? (async () => "no changes"));
  const options: ApplicationJobOptions = {
    automations: {
      list: () => [automation],
      setApplicationJobMarker: (_id, marker, enabled) => {
        automation = { ...automation, applicationJob: marker, enabled };
        return automation;
      },
      getActiveExecution: (sessionId) =>
        sessionId === execution?.sessionId ? execution : undefined,
    },
    delivery,
    getSession,
    isOwnerActive: () => active,
    isCapabilityOwned: (_owner, capability) => capability === "review.wake",
    invoke: invokeFn,
  };
  jobs = new RuntimeApplicationJobs(options);
  await outbox.start({ pauseDispatch: true });
  const grant = await delivery.grant(owner, "driver");
  const arm = () =>
    jobs.arm(owner, {
      jobKey: "pr-1",
      automationId: "automation-1",
      grantId: grant.grantId,
      capabilities: ["review.wake"],
    });
  return {
    jobs,
    delivery,
    outbox,
    arm,
    grant,
    invokeFn,
    sendAndCollect,
    getSession,
    options,
    setActive: (value: boolean) => {
      active = value;
    },
    setExecution: (value?: AutomationActiveExecution) => {
      execution = value;
    },
    setAutomation: (patch: Partial<Automation>) => {
      automation = { ...automation, ...patch };
    },
    getAutomation: () => automation,
    restart: () => {
      jobs = new RuntimeApplicationJobs(options);
      return jobs;
    },
  };
}

describe("application background jobs", () => {
  it("a disarm during asynchronous arm validation fences the pending arm", async () => {
    const h = await harness();
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    vi.spyOn(h.options, "isCapabilityOwned").mockReturnValue(gate);
    const arm = h.arm();
    await h.jobs.disarm(owner, { jobKey: "pr-1" });
    release(true);
    await expect(arm).rejects.toThrow("revoked while arming");
    expect(h.getAutomation().enabled).toBe(false);
    expect((await h.jobs.status(owner, { jobKey: "pr-1" })).state).toBe("disarmed");
  });

  it("aborted automation invocation cannot send a queued request", async () => {
    const h = await harness();
    await h.arm();
    const abort = new AbortController();
    h.invokeFn.mockImplementation(async (authority) => {
      abort.abort();
      expect(await authority.isActive()).toBe(false);
      await expect(
        h.jobs.delivery(
          authority.invocationId,
          "marshal.session.delivery.send",
          { requestId: "abort", message: "Must not dispatch" },
          abort.signal,
        ),
      ).rejects.toThrow("aborted");
      return "cancelled";
    });
    await h.jobs.invoke(
      { jobKey: "pr-1", capability: "review.wake" },
      { ...context, signal: abort.signal },
    );
    expect(h.outbox.list()).toHaveLength(0);
  });
  it("requires native UI arm authority and grants no authority to copied job IDs/session metadata", async () => {
    const h = await harness();
    const provider = createApplicationJobProvider(h.jobs, () => {
      throw new Error("No native UI authority");
    });
    await expect(
      provider.invoke("marshal.application.job.arm", { jobKey: "pr-1" }, context),
    ).rejects.toThrow("No native UI");
    const armed = await h.arm();
    h.setExecution();
    await expect(
      h.jobs.invoke(
        { jobId: armed.jobId, capability: "review.wake" },
        {
          ...context,
          metadata: { automationId: "automation-1", marshalApplicationInvocation: "copied" },
        },
      ),
    ).rejects.toThrow("current native step");
    expect(h.invokeFn).not.toHaveBeenCalled();
    expect((await provider.get?.("marshal.application.job.invoke", context))?.permissions).toEqual(
      [],
    );
  });

  it("requires a dedicated automation-owned coordinator and immutable approved configuration", async () => {
    const h = await harness();
    h.setAutomation({ targetSessionId: "driver" });
    await expect(h.arm()).rejects.toThrow("dedicated");
    h.setAutomation({ targetSessionId: undefined });
    const armed = await h.arm();
    h.setAutomation({ steps: [{ id: "main", label: "Replacement", prompt: "New instructions" }] });
    expect(await h.jobs.isArmed(armed.jobId!)).toBe(false);
    await expect(
      h.jobs.invoke({ jobKey: "pr-1", capability: "review.wake" }, context),
    ).rejects.toThrow("no longer active");
    expect((await h.jobs.status(owner, { jobKey: "pr-1" })).state).toBe("suspended-changed");
  });

  it("checks actual coordinator source and selected target runtime/workspace", async () => {
    const h = await harness();
    await h.arm();
    h.getSession.mockImplementation(async (sessionId) =>
      sessionId === "driver" ? target : { ...coordinator, source: "user" },
    );
    await expect(
      h.jobs.invoke({ jobKey: "pr-1", capability: "review.wake" }, context),
    ).rejects.toThrow("no longer active");
    h.getSession.mockImplementation(async (sessionId) =>
      sessionId === "driver" ? { ...target, workspaceName: "elsewhere" } : coordinator,
    );
    expect((await h.jobs.status(owner, { jobKey: "pr-1" })).state).toBe("suspended-changed");
  });

  it.each([
    { source: "user", automationId: "automation-1", runtimeId: "claude" },
    { source: "automation", automationId: "another-automation", runtimeId: "claude" },
    { source: "automation", automationId: "automation-1", runtimeId: "codex" },
  ])(
    "rejects a pre-existing pinned coordinator with unapproved ownership or runtime: %j",
    async (metadata) => {
      const h = await harness();
      h.setAutomation({ pinnedSessionId: "coordinator" });
      h.getSession.mockImplementation(async (sessionId) =>
        sessionId === "driver" ? target : { ...coordinator, ...metadata },
      );
      await expect(h.arm()).rejects.toThrow("Pinned coordinator must belong");
      expect(h.getAutomation().enabled).toBe(false);
      expect(h.getAutomation().applicationJob).toBeUndefined();
    },
  );

  it("accepts an owned or deleted coordinator pin but rejects the driver and later pin retargeting", async () => {
    const h = await harness();
    h.setAutomation({ pinnedSessionId: "driver" });
    await expect(h.arm()).rejects.toThrow("Pinned coordinator must belong");
    h.setAutomation({ pinnedSessionId: "coordinator" });
    const armed = await h.arm();
    expect(await h.jobs.isArmed(armed.jobId!)).toBe(true);
    h.setAutomation({ pinnedSessionId: "driver" });
    expect(await h.jobs.isArmed(armed.jobId!)).toBe(false);
    await h.jobs.disarm(owner, { jobKey: "pr-1" });
    h.setAutomation({ pinnedSessionId: "deleted-coordinator" });
    expect((await h.arm()).state).toBe("armed");
  });

  it("rechecks the automation snapshot after asynchronous coordinator validation before writing its marker", async () => {
    const h = await harness();
    h.setAutomation({ pinnedSessionId: "coordinator" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.getSession.mockImplementation(async (sessionId) => {
      if (sessionId === "driver") return target;
      await gate;
      return coordinator;
    });
    const pendingArm = h.arm();
    await vi.waitFor(() => expect(h.getSession).toHaveBeenCalledWith("coordinator"));
    h.setAutomation({
      steps: [{ id: "main", label: "Changed", prompt: "Unapproved replacement" }],
    });
    release();
    await expect(pendingArm).rejects.toThrow("Automation changed while");
    expect(h.getAutomation().applicationJob).toBeUndefined();
    expect(h.getAutomation().enabled).toBe(false);
  });

  it("no-op runs invoke only the application capability; changed runs dispatch exactly once to the bound driver", async () => {
    const h = await harness();
    const armed = await h.arm();
    await expect(
      h.jobs.invoke({ jobKey: "pr-1", capability: "review.wake" }, context),
    ).resolves.toBe("no changes");
    expect(h.outbox.list()).toHaveLength(0);
    let authority: ApplicationJobInvocation | undefined;
    h.invokeFn.mockImplementation(async (current) => {
      authority = current;
      const input = { grantId: h.grant.grantId, requestId: "cause-1", message: "Fix this check" };
      await expect(
        h.jobs.delivery(current.invocationId, "marshal.session.delivery.send", {
          ...input,
          grantId: "another-grant",
        }),
      ).rejects.toThrow("arm-time selection");
      const first = await h.jobs.delivery(
        current.invocationId,
        "marshal.session.delivery.send",
        input,
      );
      const repeat = await h.jobs.delivery(
        current.invocationId,
        "marshal.session.delivery.send",
        input,
      );
      expect(repeat.messageId).toBe(first.messageId);
      expect(first.requestId).toBe("cause-1");
      return first;
    });
    await h.jobs.invoke({ jobId: armed.jobId, capability: "review.wake" }, context);
    expect(h.outbox.list()).toHaveLength(1);
    expect(h.outbox.list()[0].target).toBe("driver");
    await expect(
      h.jobs.delivery(authority!.invocationId, "marshal.session.delivery.read", {
        requestId: "cause-1",
      }),
    ).rejects.toThrow("expired");
    h.outbox.resumeAfterRuntimeReset();
    await vi.waitFor(() => expect(h.outbox.list()[0].state).toBe("processed"));
    expect(h.sendAndCollect).toHaveBeenCalledTimes(1);
  });

  it("rejects normal user turns in the same coordinator and clears scoped authority after invocation", async () => {
    const h = await harness();
    await h.arm();
    h.invokeFn.mockImplementation(async (authority) => {
      expect(await authority.isActive()).toBe(true);
      h.setExecution({
        automationId: "automation-1",
        runId: "later",
        stepId: "main",
        sessionId: "coordinator",
        clientMessageId: "native-user-2",
      });
      expect(await authority.isActive()).toBe(false);
      await expect(
        h.jobs.delivery(authority.invocationId, "marshal.session.delivery.send", {
          requestId: "cause",
          message: "Wrong turn",
        }),
      ).rejects.toThrow("expired");
      return "expired";
    });
    await h.jobs.invoke({ jobKey: "pr-1", capability: "review.wake" }, context);
    expect(h.outbox.list()).toHaveLength(0);
  });

  it("disarm cancels queued delivery and restart markers never restore arm authority", async () => {
    const h = await harness();
    const armed = await h.arm();
    h.invokeFn.mockImplementation(async (authority) =>
      h.jobs.delivery(authority.invocationId, "marshal.session.delivery.send", {
        requestId: "cause",
        message: "Queued",
      }),
    );
    await h.jobs.invoke({ jobKey: "pr-1", capability: "review.wake" }, context);
    await h.jobs.disarm(owner, { jobKey: "pr-1" });
    expect(h.outbox.list()[0].state).toBe("cancelled");
    expect(await h.jobs.isArmed(armed.jobId!)).toBe(false);
    await h.arm();
    const restarted = h.restart();
    expect((await restarted.status(owner, { jobKey: "pr-1" })).state).toBe("suspended-restart");
    await expect(
      restarted.invoke({ jobKey: "pr-1", capability: "review.wake" }, context),
    ).rejects.toThrow("current native step");
  });

  it("revokes all matching application scopes and does not regain authority on re-enable", async () => {
    const h = await harness();
    const armed = await h.arm();
    await h.jobs.revokeApplication(owner);
    h.setActive(false);
    h.setActive(true);
    expect(await h.jobs.isArmed(armed.jobId!)).toBe(false);
    expect((await h.jobs.status(owner, { jobKey: "pr-1" })).state).toBe("disarmed");
  });

  it("allows terminal-state self-disarm only for the current job and refuses background re-arm", async () => {
    const h = await harness();
    await h.arm();
    h.invokeFn.mockImplementation(async (authority) => {
      const provider = createApplicationJobProvider(
        h.jobs,
        () => {
          throw new Error("not a UI");
        },
        () => authority.invocationId,
      );
      await expect(
        provider.invoke("marshal.application.job.disarm", { jobKey: "foreign" }, context),
      ).rejects.toThrow("own job");
      await expect(provider.invoke("marshal.application.job.arm", {}, context)).rejects.toThrow(
        "cannot arm",
      );
      expect(
        (await provider.invoke("marshal.application.job.status", { jobKey: "pr-1" }, context))
          .output,
      ).toMatchObject({ state: "armed" });
      expect(
        (await provider.invoke("marshal.application.job.disarm", { jobKey: "pr-1" }, context))
          .output,
      ).toMatchObject({ state: "disarmed" });
      expect(await authority.isActive()).toBe(false);
      return "PR terminal";
    });
    await expect(
      h.jobs.invoke({ jobKey: "pr-1", capability: "review.wake" }, context),
    ).resolves.toBe("PR terminal");
    expect(h.getAutomation().enabled).toBe(false);
  });
});
