import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
  type RelayAddress,
} from "../../../common/relay-contract";
import type {
  RelayAccountScope,
  RelayCommunityProvisionRequest,
  RelayExperienceResult,
  RelayFixedAgentRole,
  RelayFixedAgentSpecification,
  RelayGroupActivityRecordRequest,
  RelayGroupActivitySnapshot,
  RelayGroupSessionBinding,
  RelayGroupSessionBindingRemoveRequest,
  RelayGroupSessionBindingUpsertRequest,
  RelayManagedCommunityTopology,
  RelayManagedGroupCreateRequest,
  RelayManagedGroupDescriptor,
  RelayManagedGroupRenameRequest,
  RelayManagedGroupRetireRequest,
  RelayPublicationCorrelationQuery,
  RelayPublicationCorrelationRecord,
  RelayPublicationEnqueueReceipt,
  RelayPublicationIntent,
  RelaySessionCreateRequest,
  RelaySessionDescriptor,
  RelaySessionQuery,
  RelaySessionSteerReceipt,
  RelaySessionSteerRequest,
} from "../../../common/relay-experience-contract";
import {
  RELAY_FIXED_AGENT_ROLE_ORDER,
  RelayHostExperienceRuntime,
  type RelayHostExperienceConfig,
  type RelayHostExperiencePorts,
  type RelayHostFixedAgentActivationRequest,
  type RelayHostFixedAgentToolPolicyInstallRequest,
  type RelayHostFixedAgentToolPolicyRemoveRequest,
  type RelayHostSelfToolAdapter,
  type RelayHostSessionAdapter,
  type RelayHostSessionReopenRequest,
  type RelayHostSessionRetireRequest,
} from "./index";

const NOW = "2026-08-07T00:00:00.000Z";
const LATER = "2026-08-08T00:00:00.000Z";
const LATER_STILL = "2026-08-09T00:00:00.000Z";
const providerId = parseRelayProviderId("whatsapp");
const accountId = parseRelayAccountId("primary");
const account = { providerId, accountId } satisfies RelayAccountScope;
const config = {
  account,
  communityDisplayName: "Marshal",
} satisfies RelayHostExperienceConfig;

describe("RelayHostExperienceRuntime", () => {
  it("bootstraps all fixed roles in order, stops in reverse, and reuses sessions after restart", async () => {
    const harness = createHarness();
    const first = await harness.runtime.start();

    expect(first.fixedAgents.map((binding) => binding.specification.role)).toEqual(
      RELAY_FIXED_AGENT_ROLE_ORDER,
    );
    expect(harness.topology.provisionRequests).toHaveLength(1);
    expect(harness.topology.provisionRequests[0]?.groups.map((group) => group.role)).toEqual(
      RELAY_FIXED_AGENT_ROLE_ORDER,
    );
    expect(harness.sessions.createRequests.map((request) => request.kind)).toEqual([
      "fixed-agent",
      "fixed-agent",
      "fixed-agent",
    ]);
    expect(harness.events).toEqual([
      "policy-install:new-chats",
      "activate:new-chats",
      "policy-install:progress",
      "activate:progress",
      "policy-install:information-control",
      "activate:information-control",
    ]);
    expect(
      harness.selfTools.installs.map((request) => ({
        role: request.role,
        mode: request.policy.mode,
        remotePermissionApproval: request.policy.remotePermissionApproval,
      })),
    ).toEqual([
      { role: "new-chats", mode: "default-deny", remotePermissionApproval: "deny" },
      { role: "progress", mode: "default-deny", remotePermissionApproval: "deny" },
      {
        role: "information-control",
        mode: "default-deny",
        remotePermissionApproval: "deny",
      },
    ]);

    await harness.runtime.stop();
    expect(harness.events.slice(-6)).toEqual([
      "suspend:information-control",
      "policy-remove:information-control",
      "suspend:progress",
      "policy-remove:progress",
      "suspend:new-chats",
      "policy-remove:new-chats",
    ]);

    const restarted = new RelayHostExperienceRuntime(config, harness.ports);
    const recovered = await restarted.start();

    expect(recovered.fixedAgents.map((binding) => binding.session.sessionId)).toEqual(
      first.fixedAgents.map((binding) => binding.session.sessionId),
    );
    expect(harness.sessions.createRequests).toHaveLength(3);
    expect(harness.sessions.reopenRequests).toHaveLength(0);
    expect(harness.topology.provisionRequests).toHaveLength(1);
    expect(harness.events.slice(-6)).toEqual([
      "policy-install:new-chats",
      "activate:new-chats",
      "policy-install:progress",
      "activate:progress",
      "policy-install:information-control",
      "activate:information-control",
    ]);

    await restarted.stop();
    const stoppedProgress = requireFixedAgent(recovered.fixedAgents, "progress");
    harness.sessions.setStatus(stoppedProgress.session.sessionId, "ended", LATER);
    harness.sessions.replaceOnReopen = true;
    const afterEndRuntime = new RelayHostExperienceRuntime(config, harness.ports);
    const recoveredAfterEnd = await afterEndRuntime.start();
    const replacement = requireFixedAgent(recoveredAfterEnd.fixedAgents, "progress");

    expect(replacement.session.sessionId).not.toBe(stoppedProgress.session.sessionId);
    expect(replacement.binding.sessionId).toBe(replacement.session.sessionId);
    expect(harness.sessions.createRequests).toHaveLength(3);
    expect(harness.sessions.reopenRequests).toHaveLength(1);

    await afterEndRuntime.stop();
    harness.sessions.setStatus(replacement.session.sessionId, "ended", LATER_STILL);
    await new RelayHostExperienceRuntime(config, harness.ports).start();
    expect(harness.sessions.reopenRequests).toHaveLength(2);
  });

  it("retains default-deny policy when a fixed session cannot be suspended", async () => {
    const harness = createHarness();
    await harness.runtime.start();
    harness.sessions.failSuspendRole = "progress";

    await expect(harness.runtime.stop()).rejects.toBeInstanceOf(AggregateError);

    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: "stopping",
      fixedAgents: [{ specification: { role: "progress" } }],
    });
    expect(harness.selfTools.removes.map((request) => request.role)).not.toContain("progress");

    harness.sessions.failSuspendRole = undefined;
    await harness.runtime.stop();
    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: "stopped",
      fixedAgents: [],
    });
    expect(harness.selfTools.removes.map((request) => request.role)).toContain("progress");
  });

  it("keeps a later stop request authoritative while startup is queued", async () => {
    const harness = createHarness();
    const starting = harness.runtime.start();
    const stopping = harness.runtime.stop();
    const snapshot = await starting;
    const newChats = requireFixedAgent(snapshot.fixedAgents, "new-chats");

    expect(
      harness.runtime.authorizeFixedAgentTool(
        newChats.session.sessionId,
        "relay.ensure-session-group",
      ),
    ).toEqual({ allowed: false, reason: "runtime-not-running" });
    await expect(
      harness.runtime.ensureSessionGroup({
        requesterSessionId: newChats.session.sessionId,
        displayName: "Blocked",
        sessionTitle: "Blocked",
        source: newChats.group.address,
        providerMessageId: parseRelayMessageId("blocked-during-stop"),
        correlationId: "blocked-during-stop",
        idempotencyKey: "blocked-during-stop",
        requestedAt: NOW,
        input: {
          text: "Do not create",
          attachments: [],
          transcripts: [],
        },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await stopping;

    const [firstRestart, secondRestart] = await Promise.all([
      harness.runtime.start(),
      harness.runtime.start(),
    ]);
    const restartedNewChats = requireFixedAgent(firstRestart.fixedAgents, "new-chats");
    expect(secondRestart.state).toBe("running");
    expect(
      harness.runtime.authorizeFixedAgentTool(
        restartedNewChats.session.sessionId,
        "relay.ensure-session-group",
      ),
    ).toEqual({ allowed: true, reason: "allowlisted" });
  });

  it("keeps policy installed when activation and suspension both fail", async () => {
    const harness = createHarness();
    harness.sessions.failActivateRole = "progress";
    harness.sessions.failSuspendRole = "progress";

    await expect(harness.runtime.start()).rejects.toMatchObject({
      code: "unavailable",
    });

    expect(harness.selfTools.installs.map((request) => request.role)).toContain("progress");
    expect(harness.selfTools.removes.map((request) => request.role)).not.toContain("progress");
    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: "stopping",
      fixedAgents: [{ specification: { role: "progress" } }],
    });

    harness.sessions.failActivateRole = undefined;
    harness.sessions.failSuspendRole = undefined;
    await harness.runtime.stop();
    expect(harness.selfTools.removes.map((request) => request.role)).toContain("progress");
  });

  it("creates a new fixed group and session after the prior generation is retired", async () => {
    const harness = createHarness();
    const first = await harness.runtime.start();
    const oldProgress = requireFixedAgent(first.fixedAgents, "progress");
    await harness.runtime.stop();
    await harness.topology.retireGroup({
      address: oldProgress.group.address,
      idempotencyKey: "retire:progress:generation-1",
      requestedAt: LATER,
    });

    const recovered = await new RelayHostExperienceRuntime(config, harness.ports).start();
    const newProgress = requireFixedAgent(recovered.fixedAgents, "progress");

    expect(newProgress.group.address).not.toEqual(oldProgress.group.address);
    expect(newProgress.session.sessionId).not.toBe(oldProgress.session.sessionId);
    expect(
      harness.topology.createRequests.filter((request) => request.role === "progress"),
    ).toHaveLength(1);
    expect(
      harness.sessions.createRequests.filter((request) => request.kind === "fixed-agent"),
    ).toHaveLength(4);
  });

  it("recreates a missing fixed session from its stale binding generation", async () => {
    const harness = createHarness();
    const first = await harness.runtime.start();
    const oldProgress = requireFixedAgent(first.fixedAgents, "progress");
    await harness.runtime.stop();
    harness.sessions.deleteSession(oldProgress.session.sessionId);

    const recovered = await new RelayHostExperienceRuntime(config, harness.ports).start();
    const newProgress = requireFixedAgent(recovered.fixedAgents, "progress");

    expect(newProgress.session.sessionId).not.toBe(oldProgress.session.sessionId);
    expect(newProgress.binding.sessionId).toBe(newProgress.session.sessionId);
    expect(
      harness.sessions.createRequests.filter((request) => request.kind === "fixed-agent"),
    ).toHaveLength(4);
  });

  it("denies every non-allowlisted tool and rejects remote permission approval at bootstrap", async () => {
    const harness = createHarness();
    const snapshot = await harness.runtime.start();
    const newChats = requireFixedAgent(snapshot.fixedAgents, "new-chats");

    expect(
      harness.runtime.authorizeFixedAgentTool(
        newChats.session.sessionId,
        "relay.ensure-session-group",
      ),
    ).toEqual({ allowed: true, reason: "allowlisted" });
    expect(
      harness.runtime.authorizeFixedAgentTool(newChats.session.sessionId, "relay.delete-session"),
    ).toEqual({ allowed: false, reason: "not-allowlisted" });
    expect(
      harness.runtime.authorizeFixedAgentTool(
        newChats.session.sessionId,
        "settings.requestPermissionEscalation",
      ),
    ).toEqual({
      allowed: false,
      reason: "remote-permission-approval-disabled",
    });

    const invalid = createHarness([
      {
        ...fixedSpecification("new-chats"),
        toolPolicy: {
          mode: "default-deny",
          allowedTools: [{ toolId: "requestPermissionEscalation" }],
        },
      },
      fixedSpecification("progress"),
      fixedSpecification("information-control"),
    ]);
    await expect(invalid.runtime.start()).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(invalid.topology.provisionRequests).toHaveLength(0);
    expect(invalid.sessions.createRequests).toHaveLength(0);
  });

  it("creates a New Chats session exactly once and rebinds a replacement on reopen", async () => {
    const harness = createHarness();
    const snapshot = await harness.runtime.start();
    const newChats = requireFixedAgent(snapshot.fixedAgents, "new-chats");
    const request = {
      requesterSessionId: newChats.session.sessionId,
      displayName: "Investigate build",
      sessionTitle: "Investigate build",
      source: newChats.group.address,
      providerMessageId: parseRelayMessageId("new-chat-message"),
      correlationId: "new-chat-correlation",
      idempotencyKey: "new-chat:1",
      requestedAt: NOW,
      input: {
        text: "Investigate the failing build",
        attachments: [],
        transcripts: [],
      },
    } as const;

    const first = await harness.runtime.ensureSessionGroup(request);
    const duplicate = await harness.runtime.ensureSessionGroup(request);

    expect(duplicate.session.sessionId).toBe(first.session.sessionId);
    expect(
      harness.sessions.createRequests.filter((candidate) => candidate.kind === "conversation"),
    ).toHaveLength(1);
    expect(
      harness.sessions.steerRequests.filter((candidate) =>
        candidate.idempotencyKey.endsWith(":initial-steer"),
      ),
    ).toHaveLength(1);

    harness.sessions.setStatus(first.session.sessionId, "ended");
    const replay = await harness.runtime.ensureSessionGroup(request);
    expect(replay.session.status).toBe("ended");
    expect(harness.sessions.reopenRequests).toHaveLength(0);

    harness.sessions.invalidReopenResult = true;
    await expect(
      harness.runtime.reopenSessionGroup({
        group: first.group.address,
        idempotencyKey: "reopen:invalid",
        requestedAt: LATER,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    harness.sessions.invalidReopenResult = false;
    harness.sessions.replaceOnReopen = true;
    const reopened = await harness.runtime.reopenSessionGroup({
      group: first.group.address,
      idempotencyKey: "reopen:1",
      requestedAt: LATER,
    });

    expect(reopened.disposition).toBe("reopened");
    expect(reopened.session.sessionId).not.toBe(first.session.sessionId);
    expect(reopened.binding.sessionId).toBe(reopened.session.sessionId);

    await harness.runtime.steerSessionGroup({
      group: first.group.address,
      providerMessageId: parseRelayMessageId("session-message"),
      correlationId: "session-correlation",
      priority: "foreground",
      deliveryMode: "queue",
      idempotencyKey: "session-steer:1",
      requestedAt: LATER,
      input: {
        text: "Continue",
        attachments: [],
        transcripts: [],
      },
    });
    expect(harness.publication.intents).toHaveLength(0);
  });

  it("steers correlated Progress replies and exposes Information/Control query and steering", async () => {
    const harness = createHarness();
    const snapshot = await harness.runtime.start();
    const newChats = requireFixedAgent(snapshot.fixedAgents, "new-chats");
    const progress = requireFixedAgent(snapshot.fixedAgents, "progress");
    const informationControl = requireFixedAgent(snapshot.fixedAgents, "information-control");
    const dynamic = await harness.runtime.ensureSessionGroup({
      requesterSessionId: newChats.session.sessionId,
      displayName: "Ship relay",
      sessionTitle: "Ship relay",
      source: newChats.group.address,
      providerMessageId: parseRelayMessageId("create-session"),
      correlationId: "create-session-correlation",
      idempotencyKey: "new-chat:ship",
      requestedAt: NOW,
      input: {
        text: "Ship relay",
        attachments: [],
        transcripts: [],
      },
    });
    harness.publication.seedCorrelation({
      address: progress.group.address,
      publicationId: "publication-progress-1",
      correlationId: "progress-correlation",
      sourceSessionId: dynamic.session.sessionId,
      sourceTurnId: "turn-1",
      progress: {
        progressId: "progress-1",
        sequence: 1,
        state: "update",
      },
      createdAt: NOW,
      publishedAt: NOW,
    });

    await harness.runtime.steerProgressReply({
      source: progress.group.address,
      providerMessageId: parseRelayMessageId("progress-reply"),
      correlationId: "progress-correlation",
      priority: "background",
      deliveryMode: "queue",
      idempotencyKey: "progress-reply:1",
      requestedAt: LATER,
      input: {
        text: "Keep going",
        attachments: [],
        transcripts: [],
      },
    });
    expect(harness.sessions.steerRequests.at(-1)).toMatchObject({
      sessionId: dynamic.session.sessionId,
      correlationId: "progress-correlation",
      priority: "background",
      deliveryMode: "queue",
    });

    const queried = await harness.runtime.querySessions({
      requesterSessionId: informationControl.session.sessionId,
      query: { kind: "conversation" },
    });
    expect(queried.map((session) => session.sessionId)).toContain(dynamic.session.sessionId);

    await harness.runtime.controlSession({
      requesterSessionId: informationControl.session.sessionId,
      source: informationControl.group.address,
      providerMessageId: parseRelayMessageId("control-message"),
      targetSessionId: dynamic.session.sessionId,
      correlationId: "control-correlation",
      idempotencyKey: "control:1",
      requestedAt: LATER,
      input: {
        text: "Prioritize this",
        attachments: [],
        transcripts: [],
      },
    });
    expect(harness.sessions.steerRequests.at(-1)).toMatchObject({
      sessionId: dynamic.session.sessionId,
      priority: "control",
      deliveryMode: "interrupt",
    });
    harness.sessions.addSession({
      account,
      sessionId: "ungrouped-session",
      kind: "conversation",
      status: "ready",
      priority: "foreground",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const steerCount = harness.sessions.steerRequests.length;
    await expect(
      harness.runtime.controlSession({
        requesterSessionId: informationControl.session.sessionId,
        source: informationControl.group.address,
        providerMessageId: parseRelayMessageId("invalid-control-message"),
        targetSessionId: "ungrouped-session",
        correlationId: "invalid-control-correlation",
        idempotencyKey: "control:invalid",
        requestedAt: LATER,
        input: {
          text: "Do not deliver",
          attachments: [],
          transcripts: [],
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(harness.sessions.steerRequests).toHaveLength(steerCount);
    expect(harness.publication.intents).toHaveLength(0);

    await expect(
      harness.runtime.publish({
        intent: "deliberate",
        idempotencyKey: "publish:invalid-progress-metadata",
        requestedAt: LATER,
        correlationId: "invalid-progress-metadata",
        request: {
          publicationId: "publication-invalid-progress-metadata",
          address: progress.group.address,
          kind: "notification",
          text: "Not progress",
          sourceSessionId: dynamic.session.sessionId,
        },
        progress: {
          progressId: "invalid-progress",
          sequence: 1,
          state: "update",
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(harness.publication.intents).toHaveLength(0);

    await expect(
      harness.runtime.publish({
        intent: "deliberate",
        idempotencyKey: "publish:missing-source",
        requestedAt: LATER,
        correlationId: "missing-source",
        request: {
          publicationId: "publication-missing-source",
          address: progress.group.address,
          kind: "progress",
          text: "Orphaned progress",
          sourceSessionId: "missing-source-session",
        },
        progress: {
          progressId: "missing-source-progress",
          sequence: 1,
          state: "update",
        },
      }),
    ).rejects.toMatchObject({ code: "not-found" });
    expect(harness.publication.intents).toHaveLength(0);

    await harness.runtime.publish({
      intent: "deliberate",
      idempotencyKey: "publish:progress:1",
      requestedAt: LATER,
      correlationId: "published-progress-correlation",
      request: {
        publicationId: "publication-progress-2",
        address: progress.group.address,
        kind: "progress",
        text: "Working",
        sourceSessionId: dynamic.session.sessionId,
        sourceTurnId: "turn-2",
      },
      progress: {
        progressId: "progress-2",
        sequence: 1,
        state: "update",
      },
    });
    expect(harness.publication.intents).toHaveLength(1);
    expect(harness.activity.requireSnapshot(dynamic.group.address).lastSessionActivityAt).toBe(
      LATER,
    );
  });

  it("drains an accepted publication before suspending fixed agents", async () => {
    const harness = createHarness();
    const snapshot = await harness.runtime.start();
    const newChats = requireFixedAgent(snapshot.fixedAgents, "new-chats");
    const progress = requireFixedAgent(snapshot.fixedAgents, "progress");
    const informationControl = requireFixedAgent(snapshot.fixedAgents, "information-control");
    const dynamic = await harness.runtime.ensureSessionGroup({
      requesterSessionId: newChats.session.sessionId,
      displayName: "Drain publication",
      sessionTitle: "Drain publication",
      source: newChats.group.address,
      providerMessageId: parseRelayMessageId("drain-session"),
      correlationId: "drain-session",
      idempotencyKey: "drain-session",
      requestedAt: NOW,
      input: {
        text: "Start drain test",
        attachments: [],
        transcripts: [],
      },
    });
    const gate = harness.publication.pauseNextEnqueue();
    const publication = harness.runtime.publish({
      intent: "deliberate",
      idempotencyKey: "publish:drain",
      requestedAt: LATER,
      correlationId: "drain-correlation",
      request: {
        publicationId: "publication-drain",
        address: progress.group.address,
        kind: "progress",
        text: "Still working",
        sourceSessionId: dynamic.session.sessionId,
      },
      progress: {
        progressId: "progress-drain",
        sequence: 1,
        state: "update",
      },
    });
    await gate.started;

    let stopped = false;
    const stopping = harness.runtime.stop().then(() => {
      stopped = true;
    });
    await expect(
      harness.runtime.querySessions({
        requesterSessionId: informationControl.session.sessionId,
        query: {},
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(harness.selfTools.removes).toHaveLength(0);

    gate.release();
    await publication;
    await stopping;
    expect(stopped).toBe(true);
  });

  it("cleans up inactive dynamic groups without touching any fixed group", async () => {
    const harness = createHarness();
    const snapshot = await harness.runtime.start();
    const newChats = requireFixedAgent(snapshot.fixedAgents, "new-chats");
    const informationControl = requireFixedAgent(snapshot.fixedAgents, "information-control");
    const dynamic = await harness.runtime.ensureSessionGroup({
      requesterSessionId: newChats.session.sessionId,
      displayName: "Old session",
      sessionTitle: "Old session",
      source: newChats.group.address,
      providerMessageId: parseRelayMessageId("old-session"),
      correlationId: "old-session-correlation",
      idempotencyKey: "new-chat:old",
      requestedAt: NOW,
      input: {
        text: "Old work",
        attachments: [],
        transcripts: [],
      },
    });

    const result = await harness.runtime.cleanupSessionGroups({
      requesterSessionId: informationControl.session.sessionId,
      inactiveBefore: LATER,
      idempotencyKey: "cleanup:1",
      requestedAt: LATER,
    });

    expect(result.retired.map((group) => group.address.conversationId)).toEqual([
      dynamic.group.address.conversationId,
    ]);
    expect(harness.topology.retireRequests.map((request) => request.address)).toEqual([
      dynamic.group.address,
    ]);
    expect(harness.sessions.retireRequests).toEqual([]);
    expect(
      harness.topology
        .requireTopology()
        .groups.filter((group) => group.role !== "session")
        .every((group) => group.state === "active"),
    ).toBe(true);
  });

  it("keeps host session and self-tool wiring surfaces narrow", () => {
    expectTypeOf<keyof RelayHostSessionAdapter>().toEqualTypeOf<
      | "create"
      | "query"
      | "steer"
      | "activateFixedAgent"
      | "suspendFixedAgent"
      | "reopen"
      | "retire"
    >();
    expectTypeOf<keyof RelayHostSelfToolAdapter>().toEqualTypeOf<
      "installFixedAgentPolicy" | "removeFixedAgentPolicy"
    >();
  });
});

function createHarness(specifications = fixedSpecifications()) {
  const events: string[] = [];
  const topology = new FakeTopology();
  const bindings = new FakeBindings();
  const activity = new FakeActivity();
  const sessions = new FakeSessions(events);
  const selfTools = new FakeSelfTools(events);
  const publication = new FakePublication();
  const ports = {
    clock: { now: () => NOW },
    fixedAgents: new FakeFixedAgentCatalog(specifications),
    topology,
    bindings,
    activity,
    sessions,
    selfTools,
    publication,
    correlations: publication,
  } satisfies RelayHostExperiencePorts;
  return {
    events,
    topology,
    bindings,
    activity,
    sessions,
    selfTools,
    publication,
    ports,
    runtime: new RelayHostExperienceRuntime(config, ports),
  };
}

function fixedSpecifications(): readonly RelayFixedAgentSpecification[] {
  return RELAY_FIXED_AGENT_ROLE_ORDER.map(fixedSpecification);
}

function fixedSpecification(role: RelayFixedAgentRole): RelayFixedAgentSpecification {
  const priority = role === "new-chats" ? "foreground" : "control";
  const allowedTools =
    role === "new-chats"
      ? [{ toolId: "relay.ensure-session-group" }]
      : role === "progress"
        ? [{ toolId: "relay.publish-progress" }, { toolId: "relay.steer-progress-reply" }]
        : [{ toolId: "relay.query-sessions" }, { toolId: "relay.control-session" }];
  return {
    agentId: `${role}-agent`,
    specVersion: 1,
    role,
    displayName: displayName(role),
    description: `${displayName(role)} relay agent`,
    instructions: `Operate the ${displayName(role)} relay group.`,
    sessionPriority: priority,
    toolPolicy: {
      mode: "default-deny",
      allowedTools,
    },
  };
}

function displayName(role: RelayFixedAgentRole): string {
  if (role === "new-chats") return "New Chats";
  if (role === "progress") return "Progress";
  return "Information & Control";
}

function requireFixedAgent(
  bindings: readonly {
    readonly specification: RelayFixedAgentSpecification;
    readonly group: RelayManagedGroupDescriptor;
    readonly binding: RelayGroupSessionBinding;
    readonly session: RelaySessionDescriptor;
  }[],
  role: RelayFixedAgentRole,
) {
  const binding = bindings.find((candidate) => candidate.specification.role === role);
  if (!binding) throw new Error(`Missing fixed agent ${role}`);
  return binding;
}

function ok<Value>(value: Value): RelayExperienceResult<Value, never> {
  return { ok: true, value };
}

function notFound<Value>(message: string): RelayExperienceResult<Value, "not-found"> {
  return {
    ok: false,
    error: {
      code: "not-found",
      message,
      retryable: false,
    },
  };
}

function address(conversationId: string): RelayAddress {
  return {
    ...account,
    conversationId: parseRelayConversationId(conversationId),
  };
}

function addressKey(value: RelayAddress): string {
  return `${value.providerId}:${value.accountId}:${value.conversationId}`;
}

function addressesEqual(left: RelayAddress, right: RelayAddress): boolean {
  return addressKey(left) === addressKey(right);
}

class FakeFixedAgentCatalog {
  constructor(private readonly specifications: readonly RelayFixedAgentSpecification[]) {}

  list() {
    return Promise.resolve(ok(this.specifications));
  }

  get(agentId: string) {
    const specification = this.specifications.find((candidate) => candidate.agentId === agentId);
    return Promise.resolve(
      specification
        ? ok(specification)
        : notFound<RelayFixedAgentSpecification>(`Unknown agent ${agentId}`),
    );
  }
}

class FakeTopology {
  topology: RelayManagedCommunityTopology | undefined;
  readonly provisionRequests: RelayCommunityProvisionRequest[] = [];
  readonly createRequests: RelayManagedGroupCreateRequest[] = [];
  readonly retireRequests: RelayManagedGroupRetireRequest[] = [];
  private readonly groupsByIdempotencyKey = new Map<string, RelayManagedGroupDescriptor>();
  private dynamicGroupCounter = 0;

  provision(request: RelayCommunityProvisionRequest) {
    this.provisionRequests.push(request);
    if (!this.topology) {
      const communityAddress = address("community");
      this.topology = {
        community: {
          address: communityAddress,
          displayName: request.displayName,
          state: "active",
          createdAt: request.requestedAt,
          updatedAt: request.requestedAt,
        },
        groups: request.groups.map((plan) =>
          this.createDescriptor(
            communityAddress,
            plan.role,
            plan.displayName,
            plan.role,
            request.requestedAt,
          ),
        ),
        revision: 1,
      };
    }
    return Promise.resolve(ok(this.requireTopology()));
  }

  getTopology() {
    return Promise.resolve(
      this.topology
        ? ok(this.topology)
        : notFound<RelayManagedCommunityTopology>("Topology not found"),
    );
  }

  getGroup(groupAddress: RelayAddress) {
    const group = this.topology?.groups.find((candidate) =>
      addressesEqual(candidate.address, groupAddress),
    );
    return Promise.resolve(
      group ? ok(group) : notFound<RelayManagedGroupDescriptor>("Managed group not found"),
    );
  }

  createGroup(request: RelayManagedGroupCreateRequest) {
    this.createRequests.push(request);
    const existing = this.groupsByIdempotencyKey.get(request.idempotencyKey);
    if (existing) return Promise.resolve(ok(existing));
    const topology = this.requireTopology();
    const roleGeneration = topology.groups.filter((group) => group.role === request.role).length;
    let suffix: string = request.role;
    if (request.role === "session") {
      suffix = `session-${++this.dynamicGroupCounter}`;
    } else if (roleGeneration > 0) {
      suffix = `${request.role}-${roleGeneration + 1}`;
    }
    const group = this.createDescriptor(
      request.communityAddress,
      request.role,
      request.displayName,
      suffix,
      request.requestedAt,
    );
    this.groupsByIdempotencyKey.set(request.idempotencyKey, group);
    this.topology = {
      ...topology,
      groups: [...topology.groups, group],
      revision: topology.revision + 1,
    };
    return Promise.resolve(ok(group));
  }

  renameGroup(request: RelayManagedGroupRenameRequest) {
    const topology = this.requireTopology();
    const group = topology.groups.find((candidate) =>
      addressesEqual(candidate.address, request.address),
    );
    if (!group) {
      return Promise.resolve(notFound<RelayManagedGroupDescriptor>("Managed group not found"));
    }
    const renamed = {
      ...group,
      displayName: request.displayName,
      updatedAt: request.requestedAt,
    };
    this.replaceGroup(renamed);
    return Promise.resolve(ok(renamed));
  }

  retireGroup(request: RelayManagedGroupRetireRequest) {
    this.retireRequests.push(request);
    const topology = this.requireTopology();
    const group = topology.groups.find((candidate) =>
      addressesEqual(candidate.address, request.address),
    );
    if (!group) {
      return Promise.resolve(notFound<RelayManagedGroupDescriptor>("Managed group not found"));
    }
    const retired = {
      ...group,
      state: "retired" as const,
      updatedAt: request.requestedAt,
    };
    this.replaceGroup(retired);
    return Promise.resolve(ok(retired));
  }

  requireTopology(): RelayManagedCommunityTopology {
    if (!this.topology) throw new Error("Topology is not provisioned");
    return this.topology;
  }

  private createDescriptor(
    communityAddress: RelayAddress,
    role: RelayManagedGroupDescriptor["role"],
    name: string,
    suffix: string,
    timestamp: string,
  ): RelayManagedGroupDescriptor {
    return {
      address: address(suffix),
      communityAddress,
      role,
      displayName: name,
      state: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private replaceGroup(replacement: RelayManagedGroupDescriptor): void {
    const topology = this.requireTopology();
    this.topology = {
      ...topology,
      groups: topology.groups.map((group) =>
        addressesEqual(group.address, replacement.address) ? replacement : group,
      ),
      revision: topology.revision + 1,
    };
  }
}

class FakeBindings {
  private readonly bindings = new Map<string, RelayGroupSessionBinding>();
  private readonly bindingsByIdempotencyKey = new Map<string, RelayGroupSessionBinding>();
  private bindingCounter = 0;

  getByGroup(group: RelayAddress) {
    const binding = this.bindings.get(addressKey(group));
    return Promise.resolve(
      binding ? ok(binding) : notFound<RelayGroupSessionBinding>("Binding not found"),
    );
  }

  listBySession(_account: RelayAccountScope, sessionId: string) {
    return Promise.resolve(
      ok([...this.bindings.values()].filter((binding) => binding.sessionId === sessionId)),
    );
  }

  upsert(request: RelayGroupSessionBindingUpsertRequest) {
    const idempotent = this.bindingsByIdempotencyKey.get(request.idempotencyKey);
    if (idempotent) return Promise.resolve(ok(idempotent));
    const key = addressKey(request.group);
    const existing = this.bindings.get(key);
    const binding = {
      bindingId: existing?.bindingId ?? request.bindingId ?? `binding-${++this.bindingCounter}`,
      group: request.group,
      role: request.role,
      sessionId: request.sessionId,
      createdAt: existing?.createdAt ?? request.requestedAt,
      updatedAt: request.requestedAt,
    } satisfies RelayGroupSessionBinding;
    this.bindings.set(key, binding);
    this.bindingsByIdempotencyKey.set(request.idempotencyKey, binding);
    return Promise.resolve(ok(binding));
  }

  remove(request: RelayGroupSessionBindingRemoveRequest) {
    const key = addressKey(request.group);
    const binding = this.bindings.get(key);
    if (!binding || binding.bindingId !== request.bindingId) {
      return Promise.resolve(notFound<RelayGroupSessionBinding>("Binding not found"));
    }
    this.bindings.delete(key);
    return Promise.resolve(ok(binding));
  }
}

class FakeActivity {
  private readonly snapshots = new Map<string, RelayGroupActivitySnapshot>();
  private readonly snapshotsByIdempotencyKey = new Map<string, RelayGroupActivitySnapshot>();
  private readonly requestsByIdempotencyKey = new Map<string, RelayGroupActivityRecordRequest>();

  get(group: RelayAddress) {
    const snapshot = this.snapshots.get(addressKey(group));
    return Promise.resolve(
      snapshot ? ok(snapshot) : notFound<RelayGroupActivitySnapshot>("Activity not found"),
    );
  }

  record(request: RelayGroupActivityRecordRequest) {
    const idempotent = this.snapshotsByIdempotencyKey.get(request.idempotencyKey);
    const previousRequest = this.requestsByIdempotencyKey.get(request.idempotencyKey);
    if (idempotent && previousRequest) {
      if (
        !addressesEqual(previousRequest.group, request.group) ||
        previousRequest.bindingId !== request.bindingId ||
        previousRequest.kind !== request.kind ||
        previousRequest.occurredAt !== request.occurredAt ||
        previousRequest.correlationId !== request.correlationId
      ) {
        return Promise.resolve({
          ok: false as const,
          error: {
            code: "idempotency-conflict" as const,
            message: "Activity idempotency key was reused with another payload",
            retryable: false,
          },
        });
      }
      return Promise.resolve(ok(idempotent));
    }
    const key = addressKey(request.group);
    const existing = this.snapshots.get(key);
    const snapshot = {
      group: request.group,
      bindingId: request.bindingId ?? existing?.bindingId,
      lastInboundAt: request.kind === "inbound" ? request.occurredAt : existing?.lastInboundAt,
      lastPublicationAt:
        request.kind === "publication" ? request.occurredAt : existing?.lastPublicationAt,
      lastSessionActivityAt:
        request.kind === "session" ? request.occurredAt : existing?.lastSessionActivityAt,
      updatedAt: request.occurredAt,
    } satisfies RelayGroupActivitySnapshot;
    this.snapshots.set(key, snapshot);
    this.snapshotsByIdempotencyKey.set(request.idempotencyKey, snapshot);
    this.requestsByIdempotencyKey.set(request.idempotencyKey, request);
    return Promise.resolve(ok(snapshot));
  }

  requireSnapshot(group: RelayAddress): RelayGroupActivitySnapshot {
    const snapshot = this.snapshots.get(addressKey(group));
    if (!snapshot) throw new Error(`Missing activity for ${addressKey(group)}`);
    return snapshot;
  }
}

class FakeSessions implements RelayHostSessionAdapter {
  readonly createRequests: RelaySessionCreateRequest[] = [];
  readonly steerRequests: RelaySessionSteerRequest[] = [];
  readonly retireRequests: RelayHostSessionRetireRequest[] = [];
  readonly reopenRequests: RelayHostSessionReopenRequest[] = [];
  replaceOnReopen = false;
  invalidReopenResult = false;
  failActivateRole: RelayFixedAgentRole | undefined;
  failSuspendRole: RelayFixedAgentRole | undefined;
  private sessionCounter = 0;
  private fixedSessionCounter = 0;
  private reopenCounter = 0;
  private readonly sessions = new Map<string, RelaySessionDescriptor>();
  private readonly sessionsByIdempotencyKey = new Map<string, RelaySessionDescriptor>();
  private readonly reopensByIdempotencyKey = new Map<string, RelaySessionDescriptor>();
  private readonly steersByIdempotencyKey = new Map<string, RelaySessionSteerReceipt>();

  constructor(private readonly events: string[]) {}

  create(request: RelaySessionCreateRequest) {
    const existing = this.sessionsByIdempotencyKey.get(request.idempotencyKey);
    if (existing) return Promise.resolve(ok(existing));
    this.createRequests.push(request);
    const sessionId =
      request.kind === "fixed-agent"
        ? `fixed-${request.fixedAgentId}-${++this.fixedSessionCounter}`
        : `conversation-${++this.sessionCounter}`;
    const session = {
      account,
      sessionId,
      kind: request.kind,
      status: "ready",
      priority: request.priority,
      group: request.group,
      fixedAgentId: request.fixedAgentId,
      createdAt: request.requestedAt,
      updatedAt: request.requestedAt,
    } satisfies RelaySessionDescriptor;
    this.sessions.set(sessionId, session);
    this.sessionsByIdempotencyKey.set(request.idempotencyKey, session);
    return Promise.resolve(ok(session));
  }

  query(request: RelaySessionQuery) {
    const sessions = [...this.sessions.values()].filter(
      (session) =>
        session.account.providerId === request.account.providerId &&
        session.account.accountId === request.account.accountId &&
        (!request.sessionId || session.sessionId === request.sessionId) &&
        (!request.group || (!!session.group && addressesEqual(session.group, request.group))) &&
        (!request.kind || session.kind === request.kind) &&
        (!request.statuses || request.statuses.includes(session.status)),
    );
    return Promise.resolve(ok(sessions));
  }

  steer(request: RelaySessionSteerRequest) {
    const existing = this.steersByIdempotencyKey.get(request.idempotencyKey);
    if (existing) return Promise.resolve(ok(existing));
    this.steerRequests.push(request);
    const receipt = {
      sessionId: request.sessionId,
      correlationId: request.correlationId,
      deliveryMode: request.deliveryMode,
      acceptedAt: request.requestedAt,
    } satisfies RelaySessionSteerReceipt;
    this.steersByIdempotencyKey.set(request.idempotencyKey, receipt);
    return Promise.resolve(ok(receipt));
  }

  activateFixedAgent(request: RelayHostFixedAgentActivationRequest) {
    if (request.specification.role === this.failActivateRole) {
      return Promise.reject(new Error(`Cannot activate ${request.specification.role}`));
    }
    this.events.push(`activate:${request.specification.role}`);
    return Promise.resolve();
  }

  suspendFixedAgent(request: RelayHostFixedAgentActivationRequest) {
    if (request.specification.role === this.failSuspendRole) {
      return Promise.reject(new Error(`Cannot suspend ${request.specification.role}`));
    }
    this.events.push(`suspend:${request.specification.role}`);
    return Promise.resolve();
  }

  reopen(request: RelayHostSessionReopenRequest) {
    const idempotent = this.reopensByIdempotencyKey.get(request.idempotencyKey);
    if (idempotent) return Promise.resolve(ok(idempotent));
    this.reopenRequests.push(request);
    const reopened = this.invalidReopenResult
      ? ({
          ...request.session,
          sessionId: `invalid-reopen-${++this.reopenCounter}`,
          kind: "fixed-agent",
          fixedAgentId: "invalid-reopen-agent",
          status: "ready",
          updatedAt: request.requestedAt,
        } satisfies RelaySessionDescriptor)
      : ({
          ...request.session,
          sessionId: this.replaceOnReopen
            ? `reopened-${++this.reopenCounter}`
            : request.session.sessionId,
          status: "ready",
          updatedAt: request.requestedAt,
        } satisfies RelaySessionDescriptor);
    this.sessions.set(reopened.sessionId, reopened);
    this.reopensByIdempotencyKey.set(request.idempotencyKey, reopened);
    return Promise.resolve(ok(reopened));
  }

  retire(request: RelayHostSessionRetireRequest) {
    this.retireRequests.push(request);
    this.setStatus(request.sessionId, "ended");
    return Promise.resolve();
  }

  addSession(session: RelaySessionDescriptor): void {
    this.sessions.set(session.sessionId, session);
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  setStatus(sessionId: string, status: RelaySessionDescriptor["status"], updatedAt = LATER): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    this.sessions.set(sessionId, {
      ...session,
      status,
      updatedAt,
    });
  }
}

class FakeSelfTools implements RelayHostSelfToolAdapter {
  readonly installs: RelayHostFixedAgentToolPolicyInstallRequest[] = [];
  readonly removes: RelayHostFixedAgentToolPolicyRemoveRequest[] = [];

  constructor(private readonly events: string[]) {}

  installFixedAgentPolicy(request: RelayHostFixedAgentToolPolicyInstallRequest) {
    this.installs.push(request);
    this.events.push(`policy-install:${request.role}`);
    return Promise.resolve();
  }

  removeFixedAgentPolicy(request: RelayHostFixedAgentToolPolicyRemoveRequest) {
    this.removes.push(request);
    this.events.push(`policy-remove:${request.role}`);
    return Promise.resolve();
  }
}

class FakePublication {
  readonly intents: RelayPublicationIntent[] = [];
  private readonly receipts = new Map<string, RelayPublicationEnqueueReceipt>();
  private readonly correlations = new Map<string, RelayPublicationCorrelationRecord>();
  private enqueueGate:
    | {
        readonly started: () => void;
        readonly release: Promise<void>;
      }
    | undefined;

  enqueue(intent: RelayPublicationIntent) {
    const gate = this.enqueueGate;
    if (gate) {
      this.enqueueGate = undefined;
      gate.started();
      return gate.release.then(() => this.enqueueNow(intent));
    }
    return Promise.resolve(this.enqueueNow(intent));
  }

  pauseNextEnqueue(): { readonly started: Promise<void>; readonly release: () => void } {
    const started = createSignal();
    const release = createSignal();
    this.enqueueGate = {
      started: started.resolve,
      release: release.promise,
    };
    return {
      started: started.promise,
      release: release.resolve,
    };
  }

  private enqueueNow(
    intent: RelayPublicationIntent,
  ): RelayExperienceResult<RelayPublicationEnqueueReceipt, never> {
    const existing = this.receipts.get(intent.idempotencyKey);
    if (existing) return ok(existing);
    this.intents.push(intent);
    const receipt = {
      publicationId: intent.request.publicationId,
      correlationId: intent.correlationId,
      disposition: "queued",
      acceptedAt: intent.requestedAt,
    } satisfies RelayPublicationEnqueueReceipt;
    this.receipts.set(intent.idempotencyKey, receipt);
    this.correlations.set(intent.correlationId, {
      address: intent.request.address,
      publicationId: intent.request.publicationId,
      correlationId: intent.correlationId,
      sourceSessionId: intent.request.sourceSessionId,
      sourceTurnId: intent.request.sourceTurnId,
      progress: intent.progress,
      createdAt: intent.requestedAt,
    });
    return ok(receipt);
  }

  get(query: RelayPublicationCorrelationQuery) {
    const correlation = this.correlations.get(query.correlationId);
    return Promise.resolve(
      correlation
        ? ok(correlation)
        : notFound<RelayPublicationCorrelationRecord>("Correlation not found"),
    );
  }

  seedCorrelation(correlation: RelayPublicationCorrelationRecord): void {
    this.correlations.set(correlation.correlationId, correlation);
  }
}

function createSignal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolver: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolver) throw new Error("Signal is not initialized");
      resolver();
    },
  };
}
