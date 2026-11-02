import { createHash } from "node:crypto";

import type { RelayAddress } from "../../../common/relay-contract";
import {
  RELAY_FIXED_AGENT_TOOL_NAMES,
  type InstalledRelayFixedAgent,
  type PublishRelayProgressInput,
  type PublishRelayProgressResult,
  type RelayAccountScope,
  type RelayExperienceResult,
  type RelayFixedAgentHostOptions,
  type RelayFixedAgentPermissionDecision,
  type RelayFixedAgentRole,
  type RelayFixedAgentSpecification,
  type RelayFixedAgentToolDefinition,
  type RelayFixedAgentToolInvocation,
  type RelayFixedAgentToolName,
  type RelayFixedAgentToolRegistration,
  type RelayFixedAgentTurn,
  type RelayFixedAgentTurnResult,
  type RelayHostSessionDescriptor,
  type RelayManagedGroupDescriptor,
  type RelayManagedGroupRole,
  type RelayProgressReplyKind,
} from "./contracts";
import { RELAY_FIXED_AGENT_LIFECYCLE } from "./specs";
import { getRelayFixedAgentToolDefinitions } from "./tool-definitions";

type RelayFixedAgentToolHandler = (
  args: unknown,
  invocation: RelayFixedAgentToolInvocation,
) => Promise<unknown>;

const DEFAULT_SESSION_QUERY_LIMIT = 10;
const MAX_SESSION_QUERY_LIMIT = 50;
const FIXED_AGENT_ROLES: readonly RelayFixedAgentRole[] = [
  "new-chats",
  "progress",
  "information-control",
];

export class RelayFixedAgentHost {
  private readonly defaultTaskAgentId: string;
  private readonly installed = new Map<RelayFixedAgentRole, InstalledRelayFixedAgent>();
  private initialization: Promise<readonly InstalledRelayFixedAgent[]> | undefined;
  private initialized = false;

  constructor(private readonly options: RelayFixedAgentHostOptions) {
    this.defaultTaskAgentId = requireIdentifier(options.defaultTaskAgentId, "defaultTaskAgentId");
    if (!sameRelayAccount(addressAccount(options.communityAddress), options.account)) {
      throw new Error("Relay community address belongs to another configured account");
    }
  }

  initialize(): Promise<readonly InstalledRelayFixedAgent[]> {
    if (this.initialization) return this.initialization;
    const pending = this.installFixedAgents();
    this.initialization = pending;
    void pending.catch(() => {
      if (this.initialization === pending) this.initialization = undefined;
    });
    return pending;
  }

  getInstallations(): readonly InstalledRelayFixedAgent[] {
    this.assertInitialized();
    return FIXED_AGENT_ROLES.map((role) => this.requireInstallation(role));
  }

  async submitTurn(
    role: RelayFixedAgentRole,
    turn: RelayFixedAgentTurn,
  ): Promise<RelayFixedAgentTurnResult> {
    const installation = this.requireInstallation(role);
    this.validateTurn(turn);
    if (!sameRelayAddress(turn.origin.address, installation.group.address)) {
      throw new Error(`Relay ${role} turn did not originate from its managed group`);
    }
    return this.options.sessionRuntime.submitNaturalLanguageTurn(
      installation.session.sessionId,
      turn,
    );
  }

  async registerConversationSession(role: RelayFixedAgentRole, sessionId: string): Promise<void> {
    this.assertInitialized();
    const normalizedSessionId = requireIdentifier(sessionId, "sessionId");
    const specification = this.requireInstallation(role).specification;
    const handlers = this.createToolHandlers(role);
    const definitions = getRelayFixedAgentToolDefinitions(role);
    assertToolSurface(specification, definitions, handlers);
    await this.options.sessionRuntime.registerTools(
      normalizedSessionId,
      this.createToolRegistration(specification, normalizedSessionId, definitions, handlers),
    );
  }

  async publishProgress(input: PublishRelayProgressInput): Promise<PublishRelayProgressResult> {
    this.assertInitialized();
    const publicationId = requireIdentifier(input.publicationId, "publicationId");
    const correlationId = requireIdentifier(input.correlationId, "correlationId");
    const sourceSessionId = requireIdentifier(input.sourceSessionId, "sourceSessionId");
    const sourceTurnId = requireIdentifier(input.sourceTurnId, "sourceTurnId");
    const text = requireNaturalLanguage(input.text, "progress text");
    const publishedAt = requireIsoTimestamp(input.publishedAt, "publishedAt");
    validateProgress(input.progress);
    const installation = this.requireInstallation("progress");
    await this.requireSessionForAccount(
      sourceSessionId,
      this.options.account,
      "find relay progress source session",
    );

    await this.options.sessionRuntime.appendHistory(installation.session.sessionId, {
      idempotencyKey: `relay-progress-history:${encodeKeyPart(publicationId)}`,
      role: "user",
      kind: "progress-publication",
      content: text,
      createdAt: publishedAt,
      correlationId,
      sourceSessionId,
      sourceTurnId,
    });
    const receipt = requirePortValue(
      await this.options.publicationCommands.enqueue({
        idempotencyKey: `relay-progress-publication:${encodeKeyPart(publicationId)}`,
        requestedAt: publishedAt,
        intent: "deliberate",
        correlationId,
        request: {
          publicationId,
          address: installation.group.address,
          kind: "progress",
          text,
          sourceSessionId,
          sourceTurnId,
        },
        progress: input.progress,
      }),
      "enqueue relay progress",
    );
    const correlation = requirePortValue(
      await this.options.publicationCorrelations.get({
        account: this.options.account,
        correlationId,
      }),
      "read relay progress correlation",
    );
    assertCorrelationAddress(
      correlation.address,
      this.options.account,
      installation.group.address,
      correlationId,
    );
    return { correlation, receipt };
  }

  private async installFixedAgents(): Promise<readonly InstalledRelayFixedAgent[]> {
    const specifications = requirePortValue(
      await this.options.catalog.list(),
      "list relay fixed agents",
    );
    validateCatalog(specifications);
    const configuredAccountKey = accountScopeKey(this.options.account);
    const installations = await Promise.all(
      specifications.map(async (specification): Promise<InstalledRelayFixedAgent> => {
        const requestedAt = this.now();
        const fixedGroupKey = `relay-fixed-group:${configuredAccountKey}:${specification.role}`;
        const groupReceipt = requirePortValue(
          await this.options.managedGroups.ensure({
            idempotencyKey: fixedGroupKey,
            requestedAt,
            account: this.options.account,
            communityAddress: this.options.communityAddress,
            groupKey: fixedGroupKey,
            role: specification.role,
            displayName: specification.displayName,
            reopen: true,
          }),
          `ensure ${specification.role} relay group`,
        );
        assertManagedGroup(
          groupReceipt.group,
          this.options.account,
          this.options.communityAddress,
          specification.role,
        );
        const session = requirePortValue(
          await this.options.sessionCreation.create({
            idempotencyKey: `relay-fixed-session:${configuredAccountKey}:${encodeKeyPart(specification.agentId)}`,
            requestedAt,
            group: groupReceipt.group.address,
            kind: "fixed-agent",
            title: specification.displayName,
            priority: specification.sessionPriority,
            fixedAgentId: specification.agentId,
            lifecycle: RELAY_FIXED_AGENT_LIFECYCLE,
          }),
          `create ${specification.role} fixed-agent session`,
        );
        assertSessionAccount(session, this.options.account, groupReceipt.group.address);
        if (session.kind !== "fixed-agent" || session.fixedAgentId !== specification.agentId) {
          throw new Error(`Fixed-agent session does not match ${specification.role} specification`);
        }
        requirePortValue(
          await this.options.managedGroups.bind({
            idempotencyKey: `relay-fixed-binding:${configuredAccountKey}:${specification.role}`,
            requestedAt,
            group: groupReceipt.group.address,
            role: specification.role,
            sessionId: session.sessionId,
          }),
          `bind ${specification.role} fixed-agent session`,
        );
        const handlers = this.createToolHandlers(specification.role);
        const definitions = getRelayFixedAgentToolDefinitions(specification.role);
        assertToolSurface(specification, definitions, handlers);
        await this.options.sessionRuntime.registerTools(
          session.sessionId,
          this.createToolRegistration(specification, session.sessionId, definitions, handlers),
        );
        return {
          specification,
          lifecycle: RELAY_FIXED_AGENT_LIFECYCLE,
          session,
          group: groupReceipt.group,
        };
      }),
    );
    for (const installation of installations) {
      this.installed.set(installation.specification.role, installation);
    }

    this.initialized = true;
    return this.getInstallations();
  }

  private createToolRegistration(
    specification: RelayFixedAgentSpecification,
    sessionId: string,
    definitions: readonly RelayFixedAgentToolDefinition[],
    handlers: ReadonlyMap<string, RelayFixedAgentToolHandler>,
  ): RelayFixedAgentToolRegistration {
    return {
      definitions,
      policy: specification.toolPolicy,
      remotePermissionApproval: "forbidden",
      invoke: async (toolName, args, invocation) => {
        if (invocation.sessionId !== sessionId) {
          throw new Error(
            `Relay fixed-agent tool invocation targeted ${invocation.sessionId}, expected ${sessionId}`,
          );
        }
        if (
          !specification.toolPolicy.allowedTools.some(
            (allowedTool) => allowedTool.toolId === toolName,
          )
        ) {
          throw new Error(
            `Relay fixed agent "${specification.role}" denied tool "${toolName}" by default`,
          );
        }
        const handler = handlers.get(toolName);
        if (!handler) {
          throw new Error(
            `Relay fixed agent "${specification.role}" has no handler for "${toolName}"`,
          );
        }
        this.validateTurn(invocation.turn);
        return handler(args, invocation);
      },
      resolveRemotePermission: (request): RelayFixedAgentPermissionDecision => ({
        decision: "reject",
        reason:
          request.sessionId === sessionId
            ? "Remote permission approval is forbidden for relay fixed agents"
            : "Remote permission request does not belong to this relay fixed agent",
      }),
    };
  }

  private createToolHandlers(
    role: RelayFixedAgentRole,
  ): ReadonlyMap<string, RelayFixedAgentToolHandler> {
    switch (role) {
      case "new-chats":
        return new Map<string, RelayFixedAgentToolHandler>([
          [
            RELAY_FIXED_AGENT_TOOL_NAMES.newChatsClarify,
            (args, invocation) => this.clarifyNewChat(args, invocation),
          ],
          [
            RELAY_FIXED_AGENT_TOOL_NAMES.newChatsStartTask,
            (args, invocation) => this.startNewChatTask(args, invocation),
          ],
        ]);
      case "progress":
        return new Map<string, RelayFixedAgentToolHandler>([
          [
            RELAY_FIXED_AGENT_TOOL_NAMES.progressRouteReply,
            (args, invocation) => this.routeProgressReply(args, invocation),
          ],
        ]);
      case "information-control":
        return new Map<string, RelayFixedAgentToolHandler>([
          [
            RELAY_FIXED_AGENT_TOOL_NAMES.informationListRecent,
            (args, invocation) => this.listRecentSessions(args, invocation),
          ],
          [
            RELAY_FIXED_AGENT_TOOL_NAMES.informationSearch,
            (args, invocation) => this.searchSessions(args, invocation),
          ],
          [
            RELAY_FIXED_AGENT_TOOL_NAMES.informationStatus,
            (args, invocation) => this.getSessionStatus(args, invocation),
          ],
          [
            RELAY_FIXED_AGENT_TOOL_NAMES.informationOpenGroup,
            (args, invocation) => this.openSessionGroup(args, invocation),
          ],
        ]);
      default:
        return assertNever(role);
    }
  }

  private async clarifyNewChat(
    args: unknown,
    invocation: RelayFixedAgentToolInvocation,
  ): Promise<unknown> {
    const record = requireToolArgs(args, ["question"]);
    const question = requireNaturalLanguage(record.question, "question");
    const publicationId = `relay-new-chats-clarification:${stableIdentityDigest([
      invocation.turn.origin.address.providerId,
      invocation.turn.origin.address.accountId,
      invocation.turn.origin.address.conversationId,
      invocation.sessionId,
      invocation.turn.turnId,
      invocation.turn.correlationId,
      invocation.turn.origin.providerMessageId,
      invocation.turn.text,
      question,
    ])}`;
    const receipt = requirePortValue(
      await this.options.publicationCommands.enqueue({
        idempotencyKey: publicationId,
        requestedAt: invocation.turn.receivedAt,
        intent: "deliberate",
        correlationId: invocation.turn.correlationId,
        request: {
          publicationId,
          address: invocation.turn.origin.address,
          kind: "reply",
          text: question,
          replyToProviderMessageId: invocation.turn.origin.providerMessageId,
          sourceSessionId: invocation.sessionId,
          sourceTurnId: invocation.turn.turnId,
        },
      }),
      "enqueue New Chats clarification",
    );
    return {
      clarified: true,
      publicationId: receipt.publicationId,
      disposition: receipt.disposition,
    };
  }

  private async startNewChatTask(
    args: unknown,
    invocation: RelayFixedAgentToolInvocation,
  ): Promise<unknown> {
    const record = requireToolArgs(args, ["title", "request"]);
    const title = requireNaturalLanguage(record.title, "title");
    const request = requireNaturalLanguage(record.request, "request");
    const requestKey = `relay-new-chats-task:${scopedTurnKey(invocation.turn)}`;
    const requestedAt = invocation.turn.receivedAt;
    const account = accountFromTurn(invocation.turn);
    const groupReceipt = requirePortValue(
      await this.options.managedGroups.ensure({
        idempotencyKey: `${requestKey}:group`,
        requestedAt,
        account,
        communityAddress: this.options.communityAddress,
        groupKey: `${requestKey}:group`,
        role: "session",
        displayName: title,
        reopen: false,
        sourceAddress: invocation.turn.origin.address,
      }),
      "ensure task session group",
    );
    assertManagedGroup(groupReceipt.group, account, this.options.communityAddress, "session");
    const session = requirePortValue(
      await this.options.sessionCreation.create({
        idempotencyKey: requestKey,
        requestedAt,
        group: groupReceipt.group.address,
        kind: "conversation",
        title,
        priority: "foreground",
        agentId: this.defaultTaskAgentId,
        lifecycle: {
          persistence: "persistent",
          inspectable: true,
          retention: "ordinary",
          dynamicCleanup: "eligible-when-dynamic",
        },
      }),
      "create New Chats task session",
    );
    assertSessionAccount(session, account, groupReceipt.group.address);
    requirePortValue(
      await this.options.managedGroups.bind({
        idempotencyKey: `${requestKey}:binding`,
        requestedAt,
        group: groupReceipt.group.address,
        role: "session",
        sessionId: session.sessionId,
      }),
      "bind task session group",
    );
    const steering = requirePortValue(
      await this.options.sessionSteering.steer({
        idempotencyKey: `${requestKey}:initial-input`,
        requestedAt,
        source: invocation.turn.origin.address,
        providerMessageId: invocation.turn.origin.providerMessageId,
        sessionId: session.sessionId,
        correlationId: invocation.turn.correlationId,
        priority: "foreground",
        deliveryMode: "queue",
        input: {
          text: request,
          attachments: invocation.turn.attachments ?? [],
          transcripts: [],
        },
      }),
      "deliver initial task request",
    );
    return {
      sessionId: session.sessionId,
      agentId: this.defaultTaskAgentId,
      group: groupReceipt.group.address,
      groupDisposition: groupReceipt.disposition,
      deliveryMode: steering.deliveryMode,
    };
  }

  private async routeProgressReply(
    args: unknown,
    invocation: RelayFixedAgentToolInvocation,
  ): Promise<unknown> {
    const record = requireToolArgs(args, ["replyKind", "message"]);
    const replyKind = requireProgressReplyKind(record.replyKind);
    const message = requireNaturalLanguage(record.message, "message");
    const progressCorrelationId = requireIdentifier(
      invocation.turn.replyToProgressCorrelationId,
      "replyToProgressCorrelationId",
    );
    const correlationResult = await this.options.publicationCorrelations.get({
      account: accountFromTurn(invocation.turn),
      correlationId: progressCorrelationId,
    });
    if (!correlationResult.ok) {
      throw new Error(`No deliberately published progress for ${progressCorrelationId}`);
    }
    const correlation = correlationResult.value;
    if (!correlation.progress || !correlation.sourceSessionId || !correlation.sourceTurnId) {
      throw new Error(`No deliberately published progress for ${progressCorrelationId}`);
    }
    const account = accountFromTurn(invocation.turn);
    const progressGroup = this.requireInstallation("progress").group.address;
    assertCorrelationAddress(correlation.address, account, progressGroup, progressCorrelationId);
    if (!sameRelayAddress(correlation.address, invocation.turn.origin.address)) {
      throw new Error(`Progress reply origin does not match correlation ${progressCorrelationId}`);
    }
    if (
      !correlation.providerMessageId ||
      correlation.providerMessageId !== invocation.turn.replyToProviderMessageId
    ) {
      throw new Error(
        `Progress reply provider message does not match correlation ${progressCorrelationId}`,
      );
    }
    await this.requireSessionForAccount(
      correlation.sourceSessionId,
      account,
      "find correlated progress source session",
    );

    const steering = requirePortValue(
      await this.options.sessionSteering.steer({
        idempotencyKey: `relay-progress-reply:${scopedTurnKey(invocation.turn)}`,
        requestedAt: invocation.turn.receivedAt,
        source: invocation.turn.origin.address,
        providerMessageId: invocation.turn.origin.providerMessageId,
        sessionId: correlation.sourceSessionId,
        correlationId: invocation.turn.correlationId,
        priority: "control",
        deliveryMode: replyKind === "steering" ? "interrupt" : "queue",
        input: {
          text: message,
          attachments: invocation.turn.attachments ?? [],
          transcripts: [],
        },
        targetTurnId: correlation.sourceTurnId,
        relayReplyKind: replyKind,
      }),
      "route correlated progress reply",
    );
    return {
      routed: true,
      kind: replyKind,
      targetSessionId: steering.sessionId,
      targetTurnId: correlation.sourceTurnId,
      deliveryMode: steering.deliveryMode,
    };
  }

  private async listRecentSessions(
    args: unknown,
    invocation: RelayFixedAgentToolInvocation,
  ): Promise<unknown> {
    const record = requireToolArgs(args, ["limit"]);
    const limit = optionalLimit(record.limit);
    const sessions = requirePortValue(
      await this.options.sessionQuery.query({
        account: accountFromTurn(invocation.turn),
        limit,
        inspectableOnly: true,
      }),
      "list recent relay sessions",
    );
    const scopedSessions = sessionsForAccount(sessions, accountFromTurn(invocation.turn));
    return {
      sessions: scopedSessions
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.sessionId.localeCompare(right.sessionId),
        )
        .slice(0, limit),
    };
  }

  private async searchSessions(
    args: unknown,
    invocation: RelayFixedAgentToolInvocation,
  ): Promise<unknown> {
    const record = requireToolArgs(args, ["query", "limit"]);
    const query = requireNaturalLanguage(record.query, "query");
    const limit = optionalLimit(record.limit);
    const sessions = requirePortValue(
      await this.options.sessionQuery.query({
        account: accountFromTurn(invocation.turn),
        text: query,
        limit,
        inspectableOnly: true,
      }),
      "search relay sessions",
    );
    return {
      sessions: sessionsForAccount(sessions, accountFromTurn(invocation.turn)).slice(0, limit),
    };
  }

  private async getSessionStatus(
    args: unknown,
    invocation: RelayFixedAgentToolInvocation,
  ): Promise<unknown> {
    const record = requireToolArgs(args, ["sessionId"]);
    const sessionId = requireIdentifier(record.sessionId, "sessionId");
    const sessions = requirePortValue(
      await this.options.sessionQuery.query({
        account: accountFromTurn(invocation.turn),
        sessionId,
        inspectableOnly: true,
      }),
      "read relay session status",
    );
    const session = sessionsForAccount(sessions, accountFromTurn(invocation.turn)).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    return session ? { found: true, session } : { found: false, sessionId };
  }

  private async openSessionGroup(
    args: unknown,
    invocation: RelayFixedAgentToolInvocation,
  ): Promise<unknown> {
    const record = requireToolArgs(args, ["sessionId", "message"]);
    const sessionId = requireIdentifier(record.sessionId, "sessionId");
    const contactMessage = optionalNaturalLanguage(record.message, "message");
    const sessions = requirePortValue(
      await this.options.sessionQuery.query({
        account: accountFromTurn(invocation.turn),
        sessionId,
        inspectableOnly: true,
      }),
      "find relay session for group access",
    );
    const account = accountFromTurn(invocation.turn);
    const session = sessionsForAccount(sessions, account).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!session) throw new Error(`Inspectable session not found: ${sessionId}`);

    const installed = this.findInstallationBySessionId(sessionId);
    const role: RelayManagedGroupRole = installed?.specification.role ?? "session";
    const displayName =
      session.title ?? installed?.specification.displayName ?? `Session ${session.sessionId}`;
    const scopeKey = scopedAccountKey(invocation.turn);
    const groupKey = installed
      ? `relay-fixed-group:${role}`
      : `relay-session-group:${scopeKey}:${encodeKeyPart(sessionId)}`;
    const accessPoint =
      role === "session" && this.options.sessionAccessPoints
        ? await this.options.sessionAccessPoints.ensure({
            sessionId,
            displayName,
            idempotencyKey: `relay-session-access:${scopeKey}:${encodeKeyPart(sessionId)}`,
            requestedAt: invocation.turn.receivedAt,
          })
        : undefined;
    const groupReceipt =
      accessPoint ??
      requirePortValue(
        await this.options.managedGroups.ensure({
          idempotencyKey: `relay-session-access:${scopeKey}:${encodeKeyPart(sessionId)}`,
          requestedAt: invocation.turn.receivedAt,
          account,
          communityAddress: this.options.communityAddress,
          groupKey,
          role,
          displayName,
          reopen: true,
          sourceAddress: invocation.turn.origin.address,
          existingGroup: session.group,
        }),
        "ensure relay session group",
      );
    assertManagedGroup(groupReceipt.group, account, this.options.communityAddress, role);
    if (!accessPoint) {
      requirePortValue(
        await this.options.managedGroups.bind({
          idempotencyKey: `relay-session-access-binding:${scopeKey}:${encodeKeyPart(sessionId)}`,
          requestedAt: invocation.turn.receivedAt,
          group: groupReceipt.group.address,
          role,
          sessionId,
        }),
        "bind relay session access group",
      );
    }
    const activationIdentity = stableIdentityDigest([
      account.providerId,
      account.accountId,
      groupReceipt.group.address.conversationId,
      sessionId,
    ]);
    const activationPublicationId = `relay-session-group-opened:${activationIdentity}`;
    requirePortValue(
      await this.options.publicationCommands.enqueue({
        idempotencyKey: activationPublicationId,
        requestedAt: invocation.turn.receivedAt,
        intent: "deliberate",
        correlationId: `relay-session-group-opened:${activationIdentity}`,
        request: {
          publicationId: activationPublicationId,
          address: groupReceipt.group.address,
          kind: "reply",
          text: `This group is connected to the existing Marshal session "${displayName}". Messages here continue that same session.`,
        },
      }),
      "announce relay session group",
    );
    const contact =
      contactMessage && sessionId !== invocation.sessionId
        ? requirePortValue(
            await this.options.sessionSteering.steer({
              idempotencyKey: `relay-session-contact:${scopedTurnKey(invocation.turn)}:${encodeKeyPart(sessionId)}`,
              requestedAt: invocation.turn.receivedAt,
              source: invocation.turn.origin.address,
              providerMessageId: invocation.turn.origin.providerMessageId,
              sessionId,
              correlationId: `relay-session-contact:${invocation.turn.correlationId}:${encodeKeyPart(sessionId)}`,
              priority: "control",
              deliveryMode: "interrupt",
              input: {
                text: contactMessage,
                attachments: [],
                transcripts: [],
              },
            }),
            "ask relay session to contact the user",
          )
        : undefined;
    return {
      group: groupReceipt.group.address,
      sessionId,
      disposition: groupReceipt.disposition,
      role,
      contactRequested: contact !== undefined,
      ...(contact ? { contactDeliveryMode: contact.deliveryMode } : {}),
      ...(contactMessage && sessionId === invocation.sessionId
        ? { contactSkipped: "The current Information session cannot contact itself mid-turn" }
        : {}),
    };
  }

  private findInstallationBySessionId(sessionId: string): InstalledRelayFixedAgent | undefined {
    return [...this.installed.values()].find(
      (installation) => installation.session.sessionId === sessionId,
    );
  }

  private requireInstallation(role: RelayFixedAgentRole): InstalledRelayFixedAgent {
    this.assertInitialized();
    const installation = this.installed.get(role);
    if (!installation) throw new Error(`Relay fixed agent is not installed: ${role}`);
    return installation;
  }

  private async requireSessionForAccount(
    sessionId: string,
    account: RelayAccountScope,
    operation: string,
  ): Promise<RelayHostSessionDescriptor> {
    const sessions = requirePortValue(
      await this.options.sessionQuery.query({
        account,
        sessionId,
      }),
      operation,
    );
    const session = sessionsForAccount(sessions, account).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!session) throw new Error(`${operation} failed: session is outside the relay account`);
    return session;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("Relay fixed-agent host has not finished initialization");
    }
  }

  private validateTurn(turn: RelayFixedAgentTurn): void {
    requireIdentifier(turn.turnId, "turnId");
    requireIdentifier(turn.correlationId, "correlationId");
    requireNaturalLanguage(turn.text, "turn text");
    requireIsoTimestamp(turn.receivedAt, "receivedAt");
    requireIdentifier(turn.origin.address.providerId, "origin.providerId");
    requireIdentifier(turn.origin.address.accountId, "origin.accountId");
    requireIdentifier(turn.origin.address.conversationId, "origin.conversationId");
    requireIdentifier(turn.origin.providerMessageId, "origin.providerMessageId");
    if (
      turn.origin.address.providerId !== this.options.account.providerId ||
      turn.origin.address.accountId !== this.options.account.accountId
    ) {
      throw new Error("Relay fixed-agent turn belongs to another configured account");
    }
  }

  private now(): string {
    return requireIsoTimestamp(this.options.clock.now(), "relay clock timestamp");
  }
}

function validateCatalog(specifications: readonly RelayFixedAgentSpecification[]): void {
  const roles = new Set<RelayFixedAgentRole>();
  const agentIds = new Set<string>();
  for (const specification of specifications) {
    requireIdentifier(specification.agentId, "fixedAgent.agentId");
    if (!Number.isInteger(specification.specVersion) || specification.specVersion < 1) {
      throw new Error(`Invalid spec version for relay fixed agent ${specification.agentId}`);
    }
    if (roles.has(specification.role)) {
      throw new Error(`Duplicate relay fixed-agent role: ${specification.role}`);
    }
    if (agentIds.has(specification.agentId)) {
      throw new Error(`Duplicate relay fixed-agent ID: ${specification.agentId}`);
    }
    roles.add(specification.role);
    agentIds.add(specification.agentId);
  }
  if (
    specifications.length !== FIXED_AGENT_ROLES.length ||
    FIXED_AGENT_ROLES.some((role) => !roles.has(role))
  ) {
    throw new Error("Relay fixed-agent catalog must contain exactly the three managed roles");
  }
}

function assertToolSurface(
  specification: RelayFixedAgentSpecification,
  definitions: readonly RelayFixedAgentToolDefinition[],
  handlers: ReadonlyMap<string, RelayFixedAgentToolHandler>,
): void {
  const definitionNames = new Set<string>(definitions.map((definition) => definition.name));
  const allowedNames = new Set(
    specification.toolPolicy.allowedTools.map((allowedTool) => allowedTool.toolId),
  );
  if (
    specification.toolPolicy.mode !== "default-deny" ||
    definitionNames.size !== allowedNames.size ||
    handlers.size !== allowedNames.size ||
    [...allowedNames].some((name) => !definitionNames.has(name) || !handlers.has(name))
  ) {
    throw new Error(`Relay fixed agent "${specification.role}" has a mismatched tool surface`);
  }
}

function requirePortValue<Value, Code extends string>(
  result: RelayExperienceResult<Value, Code>,
  operation: string,
): Value {
  if (result.ok) return result.value;
  throw new Error(`${operation} failed (${result.error.code}): ${result.error.message}`);
}

function requireToolArgs(args: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("Relay fixed-agent tool arguments must be an object");
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!allowedKeys.includes(key)) {
      throw new TypeError(`Unexpected relay fixed-agent tool argument: ${key}`);
    }
    record[key] = value;
  }
  return record;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${label} must be a non-empty, trimmed string`);
  }
  return value;
}

function requireNaturalLanguage(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`${label} must not be empty`);
  return trimmed;
}

function optionalNaturalLanguage(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireNaturalLanguage(value, label);
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireIdentifier(value, label);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new TypeError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function optionalLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_SESSION_QUERY_LIMIT;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_SESSION_QUERY_LIMIT) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_SESSION_QUERY_LIMIT}`);
  }
  return Number(value);
}

function requireProgressReplyKind(value: unknown): RelayProgressReplyKind {
  if (value === "steering" || value === "clarification-answer") return value;
  throw new TypeError("replyKind must be steering or clarification-answer");
}

function validateProgress(progress: PublishRelayProgressInput["progress"]): void {
  requireIdentifier(progress.progressId, "progress.progressId");
  if (!Number.isInteger(progress.sequence) || progress.sequence < 0) {
    throw new TypeError("progress.sequence must be a non-negative integer");
  }
  if (
    progress.state !== "update" &&
    progress.state !== "completed" &&
    progress.state !== "failed"
  ) {
    throw new TypeError("progress.state must be update, completed, or failed");
  }
}

function sessionsForAccount(
  sessions: readonly RelayHostSessionDescriptor[],
  account: RelayAccountScope,
): RelayHostSessionDescriptor[] {
  return sessions.filter(
    (session) =>
      sameRelayAccount(session.account, account) &&
      (session.group === undefined || sameRelayAccount(addressAccount(session.group), account)) &&
      session.inspectable !== false,
  );
}

function assertSessionAccount(
  session: RelayHostSessionDescriptor,
  account: RelayAccountScope,
  group: RelayAddress,
): void {
  if (!sameRelayAccount(session.account, account) || !sameOptionalAddress(session.group, group)) {
    throw new Error(`Relay session ${session.sessionId} belongs to another account or group`);
  }
}

function assertManagedGroup(
  group: RelayManagedGroupDescriptor,
  account: RelayAccountScope,
  communityAddress: RelayAddress,
  role: RelayManagedGroupRole,
): void {
  if (
    !sameRelayAccount(addressAccount(group.address), account) ||
    !sameRelayAddress(group.communityAddress, communityAddress) ||
    group.role !== role
  ) {
    throw new Error(`Managed relay group does not match canonical ${role} scope`);
  }
}

function assertCorrelationAddress(
  address: RelayAddress,
  account: RelayAccountScope,
  expectedAddress: RelayAddress,
  correlationId: string,
): void {
  if (
    !sameRelayAccount(addressAccount(address), account) ||
    !sameRelayAddress(address, expectedAddress)
  ) {
    throw new Error(`Relay correlation ${correlationId} belongs to another account or group`);
  }
}

function sameOptionalAddress(left: RelayAddress | undefined, right: RelayAddress): boolean {
  return left !== undefined && sameRelayAddress(left, right);
}

function sameRelayAddress(left: RelayAddress, right: RelayAddress): boolean {
  return (
    left.providerId === right.providerId &&
    left.accountId === right.accountId &&
    left.conversationId === right.conversationId
  );
}

function sameRelayAccount(left: RelayAccountScope, right: RelayAccountScope): boolean {
  return left.providerId === right.providerId && left.accountId === right.accountId;
}

function addressAccount(address: RelayAddress): RelayAccountScope {
  return {
    providerId: address.providerId,
    accountId: address.accountId,
  };
}

function accountFromTurn(turn: RelayFixedAgentTurn) {
  return addressAccount(turn.origin.address);
}

function scopedTurnKey(turn: RelayFixedAgentTurn): string {
  return [
    encodeKeyPart(turn.origin.address.providerId),
    encodeKeyPart(turn.origin.address.accountId),
    encodeKeyPart(turn.origin.address.conversationId),
    encodeKeyPart(turn.correlationId),
  ].join(":");
}

function scopedAccountKey(turn: RelayFixedAgentTurn): string {
  return accountScopeKey(accountFromTurn(turn));
}

function accountScopeKey(account: RelayAccountScope): string {
  return [encodeKeyPart(account.providerId), encodeKeyPart(account.accountId)].join(":");
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function stableIdentityDigest(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function assertNever(value: never): never {
  throw new Error(`Unsupported relay fixed-agent role: ${String(value)}`);
}

export function relayFixedAgentToolMatrix(): Readonly<
  Record<RelayFixedAgentRole, readonly RelayFixedAgentToolName[]>
> {
  return {
    "new-chats": getRelayFixedAgentToolDefinitions("new-chats").map(
      (definition) => definition.name,
    ),
    progress: getRelayFixedAgentToolDefinitions("progress").map((definition) => definition.name),
    "information-control": getRelayFixedAgentToolDefinitions("information-control").map(
      (definition) => definition.name,
    ),
  };
}
