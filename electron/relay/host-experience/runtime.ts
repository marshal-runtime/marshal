import type { RelayAddress } from "../../../common/relay-contract";
import type {
  RelayExperienceErrorCode,
  RelayExperienceResult,
  RelayFixedAgentRole,
  RelayFixedAgentSpecification,
  RelayGroupActivitySnapshot,
  RelayGroupSessionBinding,
  RelayManagedCommunityTopology,
  RelayManagedGroupDescriptor,
  RelayPublicationEnqueueReceipt,
  RelayPublicationIntent,
  RelaySessionDescriptor,
  RelaySessionSteerReceipt,
} from "../../../common/relay-experience-contract";
import {
  RELAY_FIXED_AGENT_ROLE_ORDER,
  RELAY_REMOTE_PERMISSION_APPROVAL_TOOL_ID,
  RelayHostExperienceError,
  type RelayCleanupSessionGroupsRequest,
  type RelayCleanupSessionGroupsResult,
  type RelayControlSessionRequest,
  type RelayEnsuredSessionAccessPoint,
  type RelayEnsureSessionGroupRequest,
  type RelayEnsuredSessionGroup,
  type RelayEnsureSessionAccessPointRequest,
  type RelayHostExperienceConfig,
  type RelayHostExperiencePorts,
  type RelayHostExperienceRuntimeApi,
  type RelayHostExperienceSnapshot,
  type RelayHostFixedAgentRuntimeBinding,
  type RelayHostToolAuthorizationDecision,
  type RelayInformationSessionQueryRequest,
  type RelayProgressReplyRequest,
  type RelayReopenedSessionGroup,
  type RelayReopenSessionGroupRequest,
  type RelaySteerSessionGroupRequest,
} from "./types";

const OPEN_SESSION_STATUSES = new Set<RelaySessionDescriptor["status"]>([
  "creating",
  "ready",
  "busy",
  "paused",
]);

interface RelayFixedAgentStopResult {
  readonly retained: RelayHostFixedAgentRuntimeBinding[];
  readonly failures: unknown[];
}

interface RelayTargetSessionActivityContext {
  readonly group: RelayManagedGroupDescriptor;
  readonly binding?: RelayGroupSessionBinding;
}

export class RelayHostExperienceRuntime implements RelayHostExperienceRuntimeApi {
  private state: RelayHostExperienceSnapshot["state"] = "stopped";
  private stopRequested = false;
  private lifecycleRequestSequence = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private operationTail: Promise<void> = Promise.resolve();
  private readonly fixedAgentsByRole = new Map<
    RelayFixedAgentRole,
    RelayHostFixedAgentRuntimeBinding
  >();
  private readonly fixedAgentsBySessionId = new Map<string, RelayHostFixedAgentRuntimeBinding>();
  private activeOperationCount = 0;
  private readonly operationDrainWaiters = new Set<() => void>();

  constructor(
    private readonly config: RelayHostExperienceConfig,
    private readonly ports: RelayHostExperiencePorts,
  ) {
    requireText("communityDisplayName", config.communityDisplayName);
  }

  start(): Promise<RelayHostExperienceSnapshot> {
    const requestSequence = ++this.lifecycleRequestSequence;
    return this.enqueueLifecycle(() => this.startInternal(requestSequence));
  }

  stop(): Promise<void> {
    this.lifecycleRequestSequence += 1;
    this.stopRequested = true;
    return this.enqueueLifecycle(() => this.stopInternal());
  }

  getSnapshot(): RelayHostExperienceSnapshot {
    return {
      account: this.config.account,
      state: this.state,
      fixedAgents: RELAY_FIXED_AGENT_ROLE_ORDER.flatMap((role) => {
        const binding = this.fixedAgentsByRole.get(role);
        return binding ? [binding] : [];
      }),
    };
  }

  authorizeFixedAgentTool(sessionId: string, toolId: string): RelayHostToolAuthorizationDecision {
    if (this.state !== "running" || this.stopRequested) {
      return { allowed: false, reason: "runtime-not-running" };
    }
    const fixedAgent = this.fixedAgentsBySessionId.get(sessionId);
    if (!fixedAgent) {
      return { allowed: false, reason: "not-fixed-agent-session" };
    }
    const normalizedToolId = toolId.trim();
    if (!normalizedToolId) {
      return { allowed: false, reason: "invalid-tool-id" };
    }
    if (isRemotePermissionApprovalTool(normalizedToolId)) {
      return { allowed: false, reason: "remote-permission-approval-disabled" };
    }
    const allowed = fixedAgent.specification.toolPolicy.allowedTools.some(
      (tool) => tool.toolId === normalizedToolId,
    );
    return allowed
      ? { allowed: true, reason: "allowlisted" }
      : { allowed: false, reason: "not-allowlisted" };
  }

  ensureSessionGroup(request: RelayEnsureSessionGroupRequest): Promise<RelayEnsuredSessionGroup> {
    return this.runOperation(() => this.ensureSessionGroupInternal(request));
  }

  private async ensureSessionGroupInternal(
    request: RelayEnsureSessionGroupRequest,
  ): Promise<RelayEnsuredSessionGroup> {
    requireRequestIdentity(request);
    const requester = this.requireFixedAgentActor(request.requesterSessionId, "new-chats");
    if (!addressesEqual(request.source, requester.group.address)) {
      throw hostError("forbidden", "New Chats requests must originate from its managed group");
    }
    requireText("displayName", request.displayName);
    requireText("sessionTitle", request.sessionTitle);
    requireText("correlationId", request.correlationId);

    const topology = await this.getRequiredTopology();
    const group = unwrapResult(
      await this.ports.topology.createGroup({
        idempotencyKey: `${request.idempotencyKey}:group`,
        requestedAt: request.requestedAt,
        communityAddress: topology.community.address,
        role: "session",
        displayName: request.displayName,
      }),
      "create session group",
    );
    this.assertManagedGroup(group, "session");

    const existingBinding = await this.getOptionalBinding(group.address);
    let session = existingBinding
      ? await this.getSessionById(existingBinding.sessionId)
      : await this.findSessionByGroup(group.address, "conversation");

    if (!session) {
      session = unwrapResult(
        await this.ports.sessions.create({
          idempotencyKey: `${request.idempotencyKey}:session`,
          requestedAt: request.requestedAt,
          group: group.address,
          kind: "conversation",
          title: request.sessionTitle,
          priority: request.priority ?? "foreground",
        }),
        "create session-group session",
      );
    }
    this.assertConversationSession(session, group.address);

    const binding =
      existingBinding?.sessionId === session.sessionId && existingBinding.role === "session"
        ? existingBinding
        : unwrapResult(
            await this.ports.bindings.upsert({
              idempotencyKey: `${request.idempotencyKey}:binding`,
              requestedAt: request.requestedAt,
              bindingId: existingBinding?.bindingId,
              group: group.address,
              role: "session",
              sessionId: session.sessionId,
            }),
            "bind session group",
          );

    await this.recordActivity({
      idempotencyKey: `${request.idempotencyKey}:session-activity`,
      requestedAt: request.requestedAt,
      group: group.address,
      bindingId: binding.bindingId,
      kind: "session",
      occurredAt: request.requestedAt,
    });
    const steer = unwrapResult(
      await this.ports.sessions.steer({
        idempotencyKey: `${request.idempotencyKey}:initial-steer`,
        requestedAt: request.requestedAt,
        source: request.source,
        providerMessageId: request.providerMessageId,
        sessionId: session.sessionId,
        correlationId: request.correlationId,
        priority: request.priority ?? "foreground",
        deliveryMode: "queue",
        input: request.input,
      }),
      "steer new chat into session",
    );
    await this.recordActivity({
      idempotencyKey: `${request.idempotencyKey}:inbound-activity`,
      requestedAt: request.requestedAt,
      group: group.address,
      bindingId: binding.bindingId,
      kind: "inbound",
      occurredAt: request.requestedAt,
      correlationId: request.correlationId,
    });

    return { group, binding, session, steer };
  }

  ensureSessionAccessPoint(
    request: RelayEnsureSessionAccessPointRequest,
  ): Promise<RelayEnsuredSessionAccessPoint> {
    return this.runOperation(() => this.ensureSessionAccessPointInternal(request));
  }

  private async ensureSessionAccessPointInternal(
    request: RelayEnsureSessionAccessPointRequest,
  ): Promise<RelayEnsuredSessionAccessPoint> {
    requireRequestIdentity(request);
    requireText("sessionId", request.sessionId);
    requireText("displayName", request.displayName);

    const session = await this.requireSessionById(request.sessionId);
    if (session.kind !== "conversation") {
      throw hostError(
        "forbidden",
        "Only ordinary Marshal sessions may receive relay access points",
      );
    }

    const bindings = unwrapResult(
      await this.ports.bindings.listBySession(this.config.account, session.sessionId),
      `list relay access points for ${session.sessionId}`,
    );
    let replacementBinding: RelayGroupSessionBinding | undefined;
    for (const binding of bindings) {
      // Access-point checks are ordered so the first active binding wins deterministically.
      // eslint-disable-next-line no-await-in-loop
      const groupResult = await this.ports.topology.getGroup(binding.group);
      if (!groupResult.ok) {
        if (groupResult.error.code === "not-found") {
          replacementBinding ??= binding;
          continue;
        }
        throw resultError(
          groupResult.error,
          `read relay access point ${addressKey(binding.group)}`,
        );
      }
      if (groupResult.value.role !== "session") continue;
      const group = groupResult.value;
      if (group.state !== "active") continue;
      const wasOpen = OPEN_SESSION_STATUSES.has(session.status);
      // Reopening mutates the selected session and must remain serialized.
      // eslint-disable-next-line no-await-in-loop
      const reopened = await this.reopenSessionIfNeeded(
        session,
        group,
        `${request.idempotencyKey}:reopen:${binding.bindingId}`,
        request.requestedAt,
      );
      return {
        group,
        binding,
        session: reopened,
        disposition: wasOpen ? "existing" : "reopened",
      };
    }

    const topology = await this.getRequiredTopology();
    const group = unwrapResult(
      await this.ports.topology.createGroup({
        idempotencyKey: `${request.idempotencyKey}:group`,
        requestedAt: request.requestedAt,
        communityAddress: topology.community.address,
        role: "session",
        displayName: request.displayName,
        ...(replacementBinding ? { existingAddress: replacementBinding.group } : {}),
      }),
      `create relay access point for ${session.sessionId}`,
    );
    this.assertManagedGroup(group, "session");
    const binding = unwrapResult(
      await this.ports.bindings.upsert({
        idempotencyKey: `${request.idempotencyKey}:binding`,
        requestedAt: request.requestedAt,
        ...(replacementBinding ? { bindingId: replacementBinding.bindingId } : {}),
        group: group.address,
        role: "session",
        sessionId: session.sessionId,
      }),
      `bind relay access point for ${session.sessionId}`,
    );
    await this.recordActivity({
      idempotencyKey: `${request.idempotencyKey}:activity`,
      requestedAt: request.requestedAt,
      group: group.address,
      bindingId: binding.bindingId,
      kind: "session",
      occurredAt: request.requestedAt,
    });
    return {
      group,
      binding,
      session,
      disposition: replacementBinding ? "reopened" : "created",
    };
  }

  reopenSessionGroup(request: RelayReopenSessionGroupRequest): Promise<RelayReopenedSessionGroup> {
    return this.runOperation(() => {
      requireRequestIdentity(request);
      return this.reopenSessionGroupInternal(request);
    });
  }

  steerSessionGroup(request: RelaySteerSessionGroupRequest): Promise<RelaySessionSteerReceipt> {
    return this.runOperation(() => this.steerSessionGroupInternal(request));
  }

  private async steerSessionGroupInternal(
    request: RelaySteerSessionGroupRequest,
  ): Promise<RelaySessionSteerReceipt> {
    requireRequestIdentity(request);
    requireText("correlationId", request.correlationId);
    const reopened = await this.reopenSessionGroupInternal({
      group: request.group,
      idempotencyKey: `${request.idempotencyKey}:reopen`,
      requestedAt: request.requestedAt,
    });
    const receipt = unwrapResult(
      await this.ports.sessions.steer({
        idempotencyKey: `${request.idempotencyKey}:steer`,
        requestedAt: request.requestedAt,
        source: request.group,
        providerMessageId: request.providerMessageId,
        sessionId: reopened.session.sessionId,
        correlationId: request.correlationId,
        priority: request.priority,
        deliveryMode: request.deliveryMode,
        input: request.input,
      }),
      "steer session group",
    );
    await this.recordActivity({
      idempotencyKey: `${request.idempotencyKey}:activity`,
      requestedAt: request.requestedAt,
      group: request.group,
      bindingId: reopened.binding.bindingId,
      kind: "inbound",
      occurredAt: request.requestedAt,
      correlationId: request.correlationId,
    });
    return receipt;
  }

  steerProgressReply(request: RelayProgressReplyRequest): Promise<RelaySessionSteerReceipt> {
    return this.runOperation(() => this.steerProgressReplyInternal(request));
  }

  private async steerProgressReplyInternal(
    request: RelayProgressReplyRequest,
  ): Promise<RelaySessionSteerReceipt> {
    requireRequestIdentity(request);
    requireText("correlationId", request.correlationId);
    const progressGroup = await this.getManagedGroup(request.source);
    this.assertManagedGroup(progressGroup, "progress");
    const correlation = unwrapResult(
      await this.ports.correlations.get({
        account: this.config.account,
        correlationId: request.correlationId,
      }),
      "resolve progress correlation",
    );
    if (
      !correlation.progress ||
      !correlation.sourceSessionId ||
      !addressesEqual(correlation.address, progressGroup.address)
    ) {
      throw hostError(
        "conflict",
        `Correlation ${request.correlationId} is not a replyable progress publication`,
      );
    }

    let target = await this.requireSessionById(correlation.sourceSessionId);
    if (target.kind !== "conversation") {
      throw hostError("forbidden", "Progress replies may only steer conversation sessions");
    }
    if (!OPEN_SESSION_STATUSES.has(target.status)) {
      if (!target.group) {
        throw hostError(
          "conflict",
          `Session ${target.sessionId} cannot be reopened without a group`,
        );
      }
      const reopened = await this.reopenSessionGroupInternal({
        group: target.group,
        idempotencyKey: `${request.idempotencyKey}:reopen`,
        requestedAt: request.requestedAt,
      });
      target = reopened.session;
    }

    const targetActivity = await this.getTargetSessionActivityContext(target);
    const receipt = unwrapResult(
      await this.ports.sessions.steer({
        idempotencyKey: `${request.idempotencyKey}:steer`,
        requestedAt: request.requestedAt,
        source: progressGroup.address,
        providerMessageId: request.providerMessageId,
        sessionId: target.sessionId,
        correlationId: request.correlationId,
        priority: request.priority ?? "foreground",
        deliveryMode: request.deliveryMode ?? "interrupt",
        input: request.input,
      }),
      "steer progress reply",
    );
    const binding = await this.getOptionalBinding(progressGroup.address);
    await this.recordActivity({
      idempotencyKey: `${request.idempotencyKey}:activity`,
      requestedAt: request.requestedAt,
      group: progressGroup.address,
      bindingId: binding?.bindingId,
      kind: "inbound",
      occurredAt: request.requestedAt,
      correlationId: request.correlationId,
    });
    await this.recordTargetSessionActivity(
      targetActivity,
      `${request.idempotencyKey}:target-activity`,
      request.requestedAt,
      request.correlationId,
    );
    return receipt;
  }

  querySessions(
    request: RelayInformationSessionQueryRequest,
  ): Promise<readonly RelaySessionDescriptor[]> {
    return this.runOperation(async () => {
      this.requireFixedAgentActor(request.requesterSessionId, "information-control");
      return unwrapResult(
        await this.ports.sessions.query({
          ...request.query,
          account: this.config.account,
        }),
        "query relay sessions",
      );
    });
  }

  controlSession(request: RelayControlSessionRequest): Promise<RelaySessionSteerReceipt> {
    return this.runOperation(() => this.controlSessionInternal(request));
  }

  private async controlSessionInternal(
    request: RelayControlSessionRequest,
  ): Promise<RelaySessionSteerReceipt> {
    requireRequestIdentity(request);
    const requester = this.requireFixedAgentActor(
      request.requesterSessionId,
      "information-control",
    );
    if (!addressesEqual(request.source, requester.group.address)) {
      throw hostError(
        "forbidden",
        "Information/Control requests must originate from its managed group",
      );
    }
    requireText("targetSessionId", request.targetSessionId);
    requireText("correlationId", request.correlationId);

    let target = await this.requireSessionById(request.targetSessionId);
    if (target.kind !== "conversation") {
      throw hostError("forbidden", "Information/Control may only steer conversation sessions");
    }
    if (!OPEN_SESSION_STATUSES.has(target.status)) {
      if (!target.group) {
        throw hostError(
          "conflict",
          `Session ${target.sessionId} cannot be reopened without a group`,
        );
      }
      const reopened = await this.reopenSessionGroupInternal({
        group: target.group,
        idempotencyKey: `${request.idempotencyKey}:reopen`,
        requestedAt: request.requestedAt,
      });
      target = reopened.session;
    }

    const targetActivity = await this.getTargetSessionActivityContext(target);
    const receipt = unwrapResult(
      await this.ports.sessions.steer({
        idempotencyKey: `${request.idempotencyKey}:steer`,
        requestedAt: request.requestedAt,
        source: request.source,
        providerMessageId: request.providerMessageId,
        sessionId: target.sessionId,
        correlationId: request.correlationId,
        priority: "control",
        deliveryMode: "interrupt",
        input: request.input,
      }),
      "control relay session",
    );
    await this.recordActivity({
      idempotencyKey: `${request.idempotencyKey}:activity`,
      requestedAt: request.requestedAt,
      group: requester.group.address,
      bindingId: requester.binding.bindingId,
      kind: "inbound",
      occurredAt: request.requestedAt,
      correlationId: request.correlationId,
    });
    await this.recordTargetSessionActivity(
      targetActivity,
      `${request.idempotencyKey}:target-activity`,
      request.requestedAt,
      request.correlationId,
    );
    return receipt;
  }

  publish(intent: RelayPublicationIntent): Promise<RelayPublicationEnqueueReceipt> {
    return this.runOperation(() => this.publishInternal(intent));
  }

  private async publishInternal(
    intent: RelayPublicationIntent,
  ): Promise<RelayPublicationEnqueueReceipt> {
    requireRequestIdentity(intent);
    if (intent.intent !== "deliberate") {
      throw hostError("invalid-request", "Relay publications must be deliberate");
    }
    requireText("correlationId", intent.correlationId);
    const group = await this.getManagedGroup(intent.request.address);
    if (intent.request.kind === "progress") {
      this.assertManagedGroup(group, "progress");
      if (!intent.progress || !intent.request.sourceSessionId) {
        throw hostError(
          "invalid-request",
          "Progress publications require progress metadata and a source session",
        );
      }
      const sourceSession = await this.requireSessionById(intent.request.sourceSessionId);
      if (sourceSession.kind !== "conversation") {
        throw hostError("forbidden", "Progress publications require a conversation session");
      }
      await this.getTargetSessionActivityContext(sourceSession);
    } else if (intent.progress) {
      throw hostError(
        "invalid-request",
        "Only progress publications may carry progress correlation metadata",
      );
    }
    const receipt = unwrapResult(
      await this.ports.publication.enqueue(intent),
      "enqueue relay publication",
    );
    const binding = await this.getOptionalBinding(group.address);
    await this.recordActivity({
      idempotencyKey: `${intent.idempotencyKey}:activity`,
      requestedAt: intent.requestedAt,
      group: group.address,
      bindingId: binding?.bindingId,
      kind: "publication",
      occurredAt: receipt.acceptedAt,
      correlationId: intent.correlationId,
    });
    return receipt;
  }

  cleanupSessionGroups(
    request: RelayCleanupSessionGroupsRequest,
  ): Promise<RelayCleanupSessionGroupsResult> {
    return this.runOperation(() => this.cleanupSessionGroupsInternal(request));
  }

  private async cleanupSessionGroupsInternal(
    request: RelayCleanupSessionGroupsRequest,
  ): Promise<RelayCleanupSessionGroupsResult> {
    requireRequestIdentity(request);
    this.requireFixedAgentActor(request.requesterSessionId, "information-control");
    const inactiveBeforeMs = Date.parse(request.inactiveBefore);
    if (!Number.isFinite(inactiveBeforeMs)) {
      throw hostError("invalid-request", "inactiveBefore must be an ISO timestamp");
    }
    const topology = await this.getRequiredTopology();
    const candidates = topology.groups
      .filter((group) => group.role === "session" && group.state === "active")
      .sort((left, right) => addressKey(left.address).localeCompare(addressKey(right.address)));
    const retired: RelayManagedGroupDescriptor[] = [];
    const skipped: RelayManagedGroupDescriptor[] = [];
    await this.cleanupSessionGroupsAt(candidates, 0, request, inactiveBeforeMs, retired, skipped);
    return { retired, skipped };
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.lifecycleTail.then(operation);
    this.lifecycleTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  private runOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertRunning();
    } catch (error) {
      return Promise.reject(error);
    }
    this.activeOperationCount += 1;
    const current = this.operationTail.then(operation);
    this.operationTail = current.then(
      () => undefined,
      () => undefined,
    );
    return current.finally(() => {
      this.activeOperationCount -= 1;
      if (this.activeOperationCount !== 0) return;
      for (const resolve of this.operationDrainWaiters) resolve();
      this.operationDrainWaiters.clear();
    });
  }

  private waitForActiveOperations(): Promise<void> {
    if (this.activeOperationCount === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.operationDrainWaiters.add(resolve);
    });
  }

  private async startInternal(requestSequence: number): Promise<RelayHostExperienceSnapshot> {
    if (requestSequence === this.lifecycleRequestSequence) {
      this.stopRequested = false;
    }
    if (this.state === "running") return this.getSnapshot();
    if (this.state === "stopping") {
      throw hostError(
        "unavailable",
        "Relay host experience shutdown must finish before restart",
        true,
      );
    }
    this.state = "starting";
    if (this.config.mode === "access-points-only") {
      this.replaceFixedAgentBindings([]);
      this.state = "running";
      return this.getSnapshot();
    }
    const activated: RelayHostFixedAgentRuntimeBinding[] = [];
    try {
      const specifications = await this.loadFixedAgentSpecifications();
      const requestedAt = this.ports.clock.now();
      const topology = await this.ensureFixedTopology(specifications, requestedAt);

      const newChats = await this.bootstrapFixedAgent(
        this.requireSpecification(specifications, "new-chats"),
        this.requireRoleGroup(topology, "new-chats"),
        requestedAt,
      );
      activated.push(newChats);
      const progress = await this.bootstrapFixedAgent(
        this.requireSpecification(specifications, "progress"),
        this.requireRoleGroup(topology, "progress"),
        requestedAt,
      );
      activated.push(progress);
      const informationControl = await this.bootstrapFixedAgent(
        this.requireSpecification(specifications, "information-control"),
        this.requireRoleGroup(topology, "information-control"),
        requestedAt,
      );
      activated.push(informationControl);

      this.replaceFixedAgentBindings(activated);
      this.state = "running";
      return this.getSnapshot();
    } catch (error) {
      const bootstrapRetained = [...this.fixedAgentsByRole.values()];
      const rollback = await this.stopFixedAgents([...activated].reverse());
      const retained = uniqueFixedAgentBindings([...bootstrapRetained, ...rollback.retained]);
      this.replaceFixedAgentBindings(retained);
      this.state = retained.length > 0 ? "stopping" : "stopped";
      if (rollback.failures.length > 0) {
        throw new RelayHostExperienceError(
          "unavailable",
          "Relay host experience bootstrap and rollback both failed",
          false,
          { cause: new AggregateError([error, ...rollback.failures]) },
        );
      }
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    await this.waitForActiveOperations();
    const bindings = [...RELAY_FIXED_AGENT_ROLE_ORDER].reverse().flatMap((role) => {
      const binding = this.fixedAgentsByRole.get(role);
      return binding ? [binding] : [];
    });
    const result = await this.stopFixedAgents(bindings);
    this.replaceFixedAgentBindings(result.retained);
    if (result.failures.length > 0) {
      throw new AggregateError(result.failures, "Failed to stop one or more relay fixed agents");
    }
    this.state = "stopped";
  }

  private async stopFixedAgents(
    bindings: readonly RelayHostFixedAgentRuntimeBinding[],
    index = 0,
    result: RelayFixedAgentStopResult = { retained: [], failures: [] },
  ): Promise<RelayFixedAgentStopResult> {
    if (index >= bindings.length) return result;
    const binding = bindings[index];
    if (!binding) return result;
    try {
      await this.ports.sessions.suspendFixedAgent(binding);
    } catch (error) {
      result.retained.push(binding);
      result.failures.push(error);
      return this.stopFixedAgents(bindings, index + 1, result);
    }
    try {
      await this.ports.selfTools.removeFixedAgentPolicy({
        sessionId: binding.session.sessionId,
        agentId: binding.specification.agentId,
        role: binding.specification.role,
      });
    } catch (error) {
      result.retained.push(binding);
      result.failures.push(error);
    }
    return this.stopFixedAgents(bindings, index + 1, result);
  }

  private async loadFixedAgentSpecifications(): Promise<
    ReadonlyMap<RelayFixedAgentRole, RelayFixedAgentSpecification>
  > {
    const listed = unwrapResult(await this.ports.fixedAgents.list(), "list fixed relay agents");
    const specifications = new Map<RelayFixedAgentRole, RelayFixedAgentSpecification>();
    for (const specification of listed) {
      this.validateFixedAgentSpecification(specification);
      if (specifications.has(specification.role)) {
        throw hostError("conflict", `Multiple fixed agents declare role ${specification.role}`);
      }
      specifications.set(specification.role, specification);
    }
    for (const role of RELAY_FIXED_AGENT_ROLE_ORDER) {
      if (!specifications.has(role)) {
        throw hostError("not-found", `Missing fixed relay agent for role ${role}`);
      }
    }
    return specifications;
  }

  private validateFixedAgentSpecification(specification: RelayFixedAgentSpecification): void {
    requireText("agentId", specification.agentId);
    requireText("displayName", specification.displayName);
    requireText("instructions", specification.instructions);
    if (!Number.isInteger(specification.specVersion) || specification.specVersion < 1) {
      throw hostError("invalid-request", `Invalid spec version for ${specification.agentId}`);
    }
    if (specification.toolPolicy.mode !== "default-deny") {
      throw hostError(
        "forbidden",
        `Fixed agent ${specification.agentId} must use a default-deny tool policy`,
      );
    }
    normalizeAllowedToolIds(specification);
  }

  private async ensureFixedTopology(
    specifications: ReadonlyMap<RelayFixedAgentRole, RelayFixedAgentSpecification>,
    requestedAt: string,
  ): Promise<RelayManagedCommunityTopology> {
    const current = await this.ports.topology.getTopology(this.config.account);
    if (!current.ok) {
      if (current.error.code !== "not-found") {
        throw resultError(current.error, "read managed relay topology");
      }
      const provisioned = unwrapResult(
        await this.ports.topology.provision({
          ...this.config.account,
          idempotencyKey: `${this.scopeKey()}:bootstrap:topology`,
          requestedAt,
          displayName: this.config.communityDisplayName,
          groups: RELAY_FIXED_AGENT_ROLE_ORDER.map((role) => ({
            role,
            displayName: this.requireSpecification(specifications, role).displayName,
          })),
        }),
        "provision managed relay topology",
      );
      this.validateTopology(provisioned);
      return provisioned;
    }

    this.validateCommunity(current.value);
    const missingRoles = RELAY_FIXED_AGENT_ROLE_ORDER.filter(
      (role) =>
        !current.value.groups.some((group) => group.role === role && group.state === "active"),
    );
    await this.ensureMissingFixedGroups(
      missingRoles,
      0,
      current.value,
      specifications,
      requestedAt,
    );
    const refreshed =
      missingRoles.length === 0
        ? current.value
        : unwrapResult(
            await this.ports.topology.getTopology(this.config.account),
            "reload managed relay topology",
          );
    this.validateTopology(refreshed);
    return refreshed;
  }

  private async ensureMissingFixedGroups(
    roles: readonly RelayFixedAgentRole[],
    index: number,
    topology: RelayManagedCommunityTopology,
    specifications: ReadonlyMap<RelayFixedAgentRole, RelayFixedAgentSpecification>,
    requestedAt: string,
  ): Promise<void> {
    const role = roles[index];
    if (!role) return;
    unwrapResult(
      await this.ports.topology.createGroup({
        idempotencyKey: `${this.scopeKey()}:bootstrap:group:${role}:r${topology.revision}`,
        requestedAt,
        communityAddress: topology.community.address,
        role,
        displayName: this.requireSpecification(specifications, role).displayName,
      }),
      `create fixed relay group ${role}`,
    );
    await this.ensureMissingFixedGroups(roles, index + 1, topology, specifications, requestedAt);
  }

  private validateTopology(topology: RelayManagedCommunityTopology): void {
    this.validateCommunity(topology);
    for (const role of RELAY_FIXED_AGENT_ROLE_ORDER) {
      const groups = topology.groups.filter(
        (group) => group.role === role && group.state === "active",
      );
      if (groups.length !== 1) {
        throw hostError(
          "conflict",
          `Managed relay topology must contain exactly one active ${role} group`,
        );
      }
      this.assertManagedGroup(groups[0], role);
    }
  }

  private validateCommunity(topology: RelayManagedCommunityTopology): void {
    if (
      topology.community.state !== "active" ||
      !addressMatchesAccount(topology.community.address, this.config.account)
    ) {
      throw hostError(
        "conflict",
        "Managed relay community is inactive or belongs to another account",
      );
    }
  }

  private async bootstrapFixedAgent(
    specification: RelayFixedAgentSpecification,
    group: RelayManagedGroupDescriptor,
    requestedAt: string,
  ): Promise<RelayHostFixedAgentRuntimeBinding> {
    const existingBinding = await this.getOptionalBinding(group.address);
    if (existingBinding && existingBinding.role !== specification.role) {
      throw hostError(
        "conflict",
        `Fixed group ${addressKey(group.address)} has a ${existingBinding.role} binding`,
      );
    }

    let session = existingBinding
      ? await this.getSessionById(existingBinding.sessionId)
      : undefined;
    if (!session || !this.isMatchingFixedSession(session, specification, group.address)) {
      session = await this.findMatchingFixedSession(specification, group.address);
    }
    const sessionGeneration = session?.updatedAt ?? requestedAt;
    if (session) {
      session = await this.reopenSessionIfNeeded(
        session,
        group,
        `${this.scopeKey()}:bootstrap:reopen:${specification.role}:v${specification.specVersion}:${session.sessionId}:${session.updatedAt}`,
        requestedAt,
      );
    } else {
      const creationGeneration = existingBinding
        ? `${existingBinding.sessionId}:${existingBinding.updatedAt}`
        : `${group.address.conversationId}:${group.createdAt}`;
      session = unwrapResult(
        await this.ports.sessions.create({
          idempotencyKey: `${this.scopeKey()}:bootstrap:session:${specification.role}:v${specification.specVersion}:${creationGeneration}`,
          requestedAt,
          group: group.address,
          kind: "fixed-agent",
          title: specification.displayName,
          priority: specification.sessionPriority,
          fixedAgentId: specification.agentId,
        }),
        `create fixed relay session ${specification.role}`,
      );
    }
    if (
      !this.isMatchingFixedSession(session, specification, group.address) ||
      !OPEN_SESSION_STATUSES.has(session.status)
    ) {
      throw hostError(
        "conflict",
        `Session ${session.sessionId} does not satisfy fixed role ${specification.role}`,
      );
    }

    const binding =
      existingBinding?.sessionId === session.sessionId
        ? existingBinding
        : unwrapResult(
            await this.ports.bindings.upsert({
              idempotencyKey: `${this.scopeKey()}:bootstrap:binding:${specification.role}:v${specification.specVersion}:${session.sessionId}`,
              requestedAt,
              bindingId: existingBinding?.bindingId,
              group: group.address,
              role: specification.role,
              sessionId: session.sessionId,
            }),
            `bind fixed relay session ${specification.role}`,
          );
    await this.recordActivity({
      idempotencyKey: `${this.scopeKey()}:bootstrap:activity:${specification.role}:v${specification.specVersion}:${group.address.conversationId}:${session.sessionId}:${sessionGeneration}:${requestedAt}`,
      requestedAt,
      group: group.address,
      bindingId: binding.bindingId,
      kind: "session",
      occurredAt: requestedAt,
    });

    const runtimeBinding = { specification, group, binding, session };
    let policyInstalled = false;
    try {
      await this.ports.selfTools.installFixedAgentPolicy({
        sessionId: session.sessionId,
        agentId: specification.agentId,
        role: specification.role,
        specVersion: specification.specVersion,
        policy: {
          mode: "default-deny",
          allowedToolIds: normalizeAllowedToolIds(specification),
          remotePermissionApproval: "deny",
        },
      });
      policyInstalled = true;
      await this.ports.sessions.activateFixedAgent(runtimeBinding);
      return runtimeBinding;
    } catch (error) {
      if (policyInstalled) {
        try {
          await this.ports.sessions.suspendFixedAgent(runtimeBinding);
        } catch (suspensionError) {
          this.retainFixedAgentBinding(runtimeBinding);
          throw new RelayHostExperienceError(
            "unavailable",
            `Failed to activate and suspend fixed relay agent ${specification.role}`,
            false,
            { cause: new AggregateError([error, suspensionError]) },
          );
        }
        try {
          await this.ports.selfTools.removeFixedAgentPolicy({
            sessionId: session.sessionId,
            agentId: specification.agentId,
            role: specification.role,
          });
        } catch (policyError) {
          this.retainFixedAgentBinding(runtimeBinding);
          throw new RelayHostExperienceError(
            "unavailable",
            `Failed to remove policy from suspended fixed relay agent ${specification.role}`,
            false,
            { cause: new AggregateError([error, policyError]) },
          );
        }
      }
      throw error;
    }
  }

  private async findMatchingFixedSession(
    specification: RelayFixedAgentSpecification,
    group: RelayAddress,
  ): Promise<RelaySessionDescriptor | undefined> {
    const sessions = unwrapResult(
      await this.ports.sessions.query({
        account: this.config.account,
        group,
        kind: "fixed-agent",
      }),
      `query fixed relay session ${specification.role}`,
    ).filter((session) => this.isMatchingFixedSession(session, specification, group));
    if (sessions.length > 1) {
      throw hostError("conflict", `Multiple sessions satisfy fixed role ${specification.role}`);
    }
    return sessions[0];
  }

  private isMatchingFixedSession(
    session: RelaySessionDescriptor,
    specification: RelayFixedAgentSpecification,
    group: RelayAddress,
  ): boolean {
    return (
      session.kind === "fixed-agent" &&
      session.account.providerId === this.config.account.providerId &&
      session.account.accountId === this.config.account.accountId &&
      session.fixedAgentId === specification.agentId &&
      session.priority === specification.sessionPriority &&
      !!session.group &&
      addressesEqual(session.group, group)
    );
  }

  private async reopenSessionGroupInternal(
    request: RelayReopenSessionGroupRequest,
  ): Promise<RelayReopenedSessionGroup> {
    const group = await this.getManagedGroup(request.group);
    this.assertManagedGroup(group, "session");
    const binding = await this.requireBinding(group.address);
    const session = await this.requireSessionById(binding.sessionId);
    this.assertConversationSession(session, group.address);
    const wasOpen = OPEN_SESSION_STATUSES.has(session.status);
    const reopened = await this.reopenSessionIfNeeded(
      session,
      group,
      `${request.idempotencyKey}:session`,
      request.requestedAt,
    );
    this.assertConversationSession(reopened, group.address);
    if (!OPEN_SESSION_STATUSES.has(reopened.status)) {
      throw hostError(
        "conflict",
        `Reopened session ${reopened.sessionId} is not available for steering`,
      );
    }
    const currentBinding =
      reopened.sessionId === binding.sessionId
        ? binding
        : unwrapResult(
            await this.ports.bindings.upsert({
              idempotencyKey: `${request.idempotencyKey}:binding`,
              requestedAt: request.requestedAt,
              bindingId: binding.bindingId,
              group: group.address,
              role: "session",
              sessionId: reopened.sessionId,
            }),
            "update reopened session-group binding",
          );
    this.assertSessionBinding(currentBinding, group, reopened);
    await this.recordActivity({
      idempotencyKey: `${request.idempotencyKey}:activity`,
      requestedAt: request.requestedAt,
      group: group.address,
      bindingId: currentBinding.bindingId,
      kind: "session",
      occurredAt: request.requestedAt,
    });
    return {
      group,
      binding: currentBinding,
      session: reopened,
      disposition: wasOpen ? "already-open" : "reopened",
    };
  }

  private async reopenSessionIfNeeded(
    session: RelaySessionDescriptor,
    group: RelayManagedGroupDescriptor,
    idempotencyKey: string,
    requestedAt: string,
  ): Promise<RelaySessionDescriptor> {
    if (OPEN_SESSION_STATUSES.has(session.status)) return session;
    return unwrapResult(
      await this.ports.sessions.reopen({
        idempotencyKey,
        requestedAt,
        session,
        group,
      }),
      `reopen relay session ${session.sessionId}`,
    );
  }

  private async findSessionByGroup(
    group: RelayAddress,
    kind: RelaySessionDescriptor["kind"],
  ): Promise<RelaySessionDescriptor | undefined> {
    const sessions = unwrapResult(
      await this.ports.sessions.query({
        account: this.config.account,
        group,
        kind,
      }),
      "query relay session by group",
    );
    if (sessions.length > 1) {
      throw hostError("conflict", `Multiple ${kind} sessions are bound to ${addressKey(group)}`);
    }
    return sessions[0];
  }

  private async getSessionById(sessionId: string): Promise<RelaySessionDescriptor | undefined> {
    const sessions = unwrapResult(
      await this.ports.sessions.query({
        account: this.config.account,
        sessionId,
      }),
      `query relay session ${sessionId}`,
    );
    if (sessions.length > 1) {
      throw hostError("conflict", `Session query ${sessionId} returned multiple records`);
    }
    return sessions[0];
  }

  private async requireSessionById(sessionId: string): Promise<RelaySessionDescriptor> {
    const session = await this.getSessionById(sessionId);
    if (!session) {
      throw hostError("not-found", `Relay session ${sessionId} was not found`);
    }
    return session;
  }

  private async getRequiredTopology(): Promise<RelayManagedCommunityTopology> {
    const topology = unwrapResult(
      await this.ports.topology.getTopology(this.config.account),
      "read managed relay topology",
    );
    this.validateTopology(topology);
    return topology;
  }

  private async getManagedGroup(address: RelayAddress): Promise<RelayManagedGroupDescriptor> {
    const group = unwrapResult(
      await this.ports.topology.getGroup(address),
      `read managed relay group ${addressKey(address)}`,
    );
    if (!addressMatchesAccount(group.address, this.config.account) || group.state !== "active") {
      throw hostError("forbidden", "Relay group is inactive or belongs to another account");
    }
    return group;
  }

  private async getOptionalBinding(
    group: RelayAddress,
  ): Promise<RelayGroupSessionBinding | undefined> {
    const result = await this.ports.bindings.getByGroup(group);
    if (result.ok) return result.value;
    if (result.error.code === "not-found") return undefined;
    throw resultError(result.error, `read binding for ${addressKey(group)}`);
  }

  private async requireBinding(group: RelayAddress): Promise<RelayGroupSessionBinding> {
    const binding = await this.getOptionalBinding(group);
    if (!binding) {
      throw hostError("not-found", `Relay group ${addressKey(group)} has no session binding`);
    }
    if (binding.role !== "session") {
      throw hostError("conflict", `Relay group ${addressKey(group)} is not a session group`);
    }
    return binding;
  }

  private async getOptionalActivity(
    group: RelayAddress,
  ): Promise<RelayGroupActivitySnapshot | undefined> {
    const result = await this.ports.activity.get(group);
    if (result.ok) return result.value;
    if (result.error.code === "not-found") return undefined;
    throw resultError(result.error, `read activity for ${addressKey(group)}`);
  }

  private async recordActivity(
    request: Parameters<RelayHostExperiencePorts["activity"]["record"]>[0],
  ): Promise<void> {
    unwrapResult(await this.ports.activity.record(request), "record relay group activity");
  }

  private async getTargetSessionActivityContext(
    session: RelaySessionDescriptor,
  ): Promise<RelayTargetSessionActivityContext> {
    if (!session.group) {
      throw hostError("conflict", `Session ${session.sessionId} has no managed group`);
    }
    const group = await this.getManagedGroup(session.group);
    this.assertManagedGroup(group, "session");
    const binding = await this.getOptionalBinding(group.address);
    if (!binding) {
      throw hostError(
        "not-found",
        `Session group ${addressKey(group.address)} has no session binding`,
      );
    }
    if (binding.sessionId !== session.sessionId) {
      throw hostError(
        "conflict",
        `Session group ${addressKey(group.address)} is bound to another session`,
      );
    }
    return { group, binding };
  }

  private async recordTargetSessionActivity(
    context: RelayTargetSessionActivityContext,
    idempotencyKey: string,
    requestedAt: string,
    correlationId: string,
  ): Promise<void> {
    await this.recordActivity({
      idempotencyKey,
      requestedAt,
      group: context.group.address,
      bindingId: context.binding?.bindingId,
      kind: "session",
      occurredAt: requestedAt,
      correlationId,
    });
  }

  private replaceFixedAgentBindings(bindings: readonly RelayHostFixedAgentRuntimeBinding[]): void {
    this.fixedAgentsByRole.clear();
    this.fixedAgentsBySessionId.clear();
    for (const binding of bindings) {
      this.fixedAgentsByRole.set(binding.specification.role, binding);
      this.fixedAgentsBySessionId.set(binding.session.sessionId, binding);
    }
  }

  private retainFixedAgentBinding(binding: RelayHostFixedAgentRuntimeBinding): void {
    this.fixedAgentsByRole.set(binding.specification.role, binding);
    this.fixedAgentsBySessionId.set(binding.session.sessionId, binding);
  }

  private requireFixedAgentActor(
    sessionId: string,
    role: RelayFixedAgentRole,
  ): RelayHostFixedAgentRuntimeBinding {
    const binding = this.fixedAgentsBySessionId.get(sessionId);
    if (!binding || binding.specification.role !== role) {
      throw hostError("forbidden", `Operation requires the ${role} fixed agent`);
    }
    return binding;
  }

  private requireSpecification(
    specifications: ReadonlyMap<RelayFixedAgentRole, RelayFixedAgentSpecification>,
    role: RelayFixedAgentRole,
  ): RelayFixedAgentSpecification {
    const specification = specifications.get(role);
    if (!specification) {
      throw hostError("not-found", `Missing fixed relay agent for role ${role}`);
    }
    return specification;
  }

  private requireRoleGroup(
    topology: RelayManagedCommunityTopology,
    role: RelayFixedAgentRole,
  ): RelayManagedGroupDescriptor {
    const group = topology.groups.find(
      (candidate) => candidate.role === role && candidate.state === "active",
    );
    if (!group) {
      throw hostError("not-found", `Missing active fixed relay group ${role}`);
    }
    return group;
  }

  private assertManagedGroup(
    group: RelayManagedGroupDescriptor,
    role: RelayManagedGroupDescriptor["role"],
  ): void {
    if (
      group.role !== role ||
      group.state !== "active" ||
      !addressMatchesAccount(group.address, this.config.account) ||
      !addressMatchesAccount(group.communityAddress, this.config.account)
    ) {
      throw hostError("conflict", `Managed relay group does not satisfy role ${role}`);
    }
  }

  private assertConversationSession(session: RelaySessionDescriptor, group: RelayAddress): void {
    if (
      session.kind !== "conversation" ||
      session.account.providerId !== this.config.account.providerId ||
      session.account.accountId !== this.config.account.accountId ||
      !session.group ||
      !addressesEqual(session.group, group) ||
      !addressMatchesAccount(session.group, this.config.account)
    ) {
      throw hostError(
        "conflict",
        `Session ${session.sessionId} is not the conversation session for ${addressKey(group)}`,
      );
    }
  }

  private assertSessionBinding(
    binding: RelayGroupSessionBinding,
    group: RelayManagedGroupDescriptor,
    session: RelaySessionDescriptor,
  ): void {
    if (
      binding.role !== "session" ||
      binding.sessionId !== session.sessionId ||
      !addressesEqual(binding.group, group.address)
    ) {
      throw hostError(
        "conflict",
        `Session-group binding for ${addressKey(group.address)} is stale or invalid`,
      );
    }
  }

  private assertRunning(): void {
    if (this.state !== "running" || this.stopRequested) {
      throw hostError("unavailable", `Relay host experience is ${this.state}`, true);
    }
  }

  private scopeKey(): string {
    return `relay-host:${this.config.account.providerId}:${this.config.account.accountId}`;
  }

  private async cleanupSessionGroupsAt(
    groups: readonly RelayManagedGroupDescriptor[],
    index: number,
    request: RelayCleanupSessionGroupsRequest,
    inactiveBeforeMs: number,
    retired: RelayManagedGroupDescriptor[],
    skipped: RelayManagedGroupDescriptor[],
  ): Promise<void> {
    const group = groups[index];
    if (!group) return;
    const activity = await this.getOptionalActivity(group.address);
    const lastActivityMs = activity ? latestActivityTime(activity) : undefined;
    if (lastActivityMs === undefined || lastActivityMs >= inactiveBeforeMs) {
      skipped.push(group);
    } else {
      const binding = await this.getOptionalBinding(group.address);
      const retiredGroup = unwrapResult(
        await this.ports.topology.retireGroup({
          idempotencyKey: `${request.idempotencyKey}:group:${group.address.conversationId}`,
          requestedAt: request.requestedAt,
          address: group.address,
        }),
        `retire session group ${addressKey(group.address)}`,
      );
      if (binding) {
        unwrapResult(
          await this.ports.bindings.remove({
            idempotencyKey: `${request.idempotencyKey}:binding:${binding.bindingId}`,
            requestedAt: request.requestedAt,
            bindingId: binding.bindingId,
            group: group.address,
          }),
          `remove retired binding ${binding.bindingId}`,
        );
      }
      retired.push(retiredGroup);
    }
    await this.cleanupSessionGroupsAt(
      groups,
      index + 1,
      request,
      inactiveBeforeMs,
      retired,
      skipped,
    );
  }
}

function uniqueFixedAgentBindings(
  bindings: readonly RelayHostFixedAgentRuntimeBinding[],
): RelayHostFixedAgentRuntimeBinding[] {
  const unique = new Map<string, RelayHostFixedAgentRuntimeBinding>();
  for (const binding of bindings) unique.set(binding.session.sessionId, binding);
  return [...unique.values()];
}

function unwrapResult<Value, Code extends RelayExperienceErrorCode>(
  result: RelayExperienceResult<Value, Code>,
  operation: string,
): Value {
  if (result.ok) return result.value;
  throw resultError(result.error, operation);
}

function resultError(
  error: {
    readonly code: RelayExperienceErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  },
  operation: string,
): RelayHostExperienceError {
  return new RelayHostExperienceError(
    error.code,
    `${operation}: ${error.message}`,
    error.retryable,
  );
}

function hostError(
  code: RelayExperienceErrorCode,
  message: string,
  retryable = false,
): RelayHostExperienceError {
  return new RelayHostExperienceError(code, message, retryable);
}

function requireRequestIdentity(request: {
  readonly idempotencyKey: string;
  readonly requestedAt: string;
}): void {
  requireText("idempotencyKey", request.idempotencyKey);
  requireText("requestedAt", request.requestedAt);
}

function requireText(field: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw hostError("invalid-request", `${field} must be a non-empty string`);
  }
  return normalized;
}

function normalizeAllowedToolIds(specification: RelayFixedAgentSpecification): readonly string[] {
  const allowed = new Set<string>();
  for (const tool of specification.toolPolicy.allowedTools) {
    const toolId = requireText("toolId", tool.toolId);
    if (isRemotePermissionApprovalTool(toolId)) {
      throw hostError(
        "forbidden",
        `Fixed agent ${specification.agentId} cannot approve remote permission changes`,
      );
    }
    allowed.add(toolId);
  }
  return [...allowed];
}

function isRemotePermissionApprovalTool(toolId: string): boolean {
  const leaf = toolId.split(/[.:/]/).at(-1) ?? toolId;
  return (
    leaf.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase() ===
    RELAY_REMOTE_PERMISSION_APPROVAL_TOOL_ID.toLowerCase()
  );
}

function addressesEqual(left: RelayAddress, right: RelayAddress): boolean {
  return (
    left.providerId === right.providerId &&
    left.accountId === right.accountId &&
    left.conversationId === right.conversationId
  );
}

function addressMatchesAccount(
  address: RelayAddress,
  account: RelayHostExperienceConfig["account"],
): boolean {
  return address.providerId === account.providerId && address.accountId === account.accountId;
}

function addressKey(address: RelayAddress): string {
  return `${address.providerId}:${address.accountId}:${address.conversationId}`;
}

function latestActivityTime(activity: RelayGroupActivitySnapshot): number | undefined {
  const timestamps = [
    activity.lastInboundAt,
    activity.lastPublicationAt,
    activity.lastSessionActivityAt,
  ].flatMap((timestamp) => (timestamp ? [Date.parse(timestamp)] : []));
  const valid = timestamps.filter(Number.isFinite);
  return valid.length > 0 ? Math.max(...valid) : undefined;
}
