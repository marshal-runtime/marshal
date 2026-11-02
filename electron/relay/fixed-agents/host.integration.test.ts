import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseRelayAccountId,
  parseRelayConversationId,
  parseRelayMessageId,
  parseRelayProviderId,
} from "../../../common/relay-contract";
import type { RelayAddress } from "../../../common/relay-contract";
import type {
  RelayAccountScope as CanonicalRelayAccountScope,
  RelayFixedAgentSpecification as CanonicalRelayFixedAgentSpecification,
  RelayManagedGroupRole as CanonicalRelayManagedGroupRole,
} from "../../../common/relay-experience-contract";
import {
  RELAY_FIXED_AGENT_SPECIFICATIONS,
  RELAY_FIXED_AGENT_TOOL_NAMES,
  RELAY_FIXED_AGENT_TOOL_POLICY_MISMATCHES,
  RelayFixedAgentHost,
  createRelayFixedAgentCatalog,
  relayFixedAgentToolMatrix,
  type RelayAccountScope,
  type RelayAllowedToolDescriptor,
  type RelayClock,
  type RelayDefaultDenyToolPolicyDescriptor,
  type RelayExperienceResult,
  type RelayFixedAgentCatalogPort,
  type RelayFixedAgentManagedGroupPort,
  type RelayFixedAgentRole,
  type RelayFixedAgentRuntimePort,
  type RelayFixedAgentSpecification,
  type RelayFixedAgentToolRegistration,
  type RelayFixedAgentTurn,
  type RelayFixedAgentTurnResult,
  type RelayGroupSessionBinding,
  type RelayGroupSessionBindingUpsertRequest,
  type RelayHostHistoryEntry,
  type RelayHostSessionCreateRequest,
  type RelayHostSessionDescriptor,
  type RelayHostSessionQuery,
  type RelayHostSessionSteerRequest,
  type RelayManagedGroupDescriptor,
  type RelayManagedGroupEnsureReceipt,
  type RelayManagedGroupEnsureRequest,
  type RelayManagedGroupRole,
  type RelayPersistenceErrorCode,
  type RelayPublicationCommandPort,
  type RelayPublicationCorrelationQuery,
  type RelayPublicationCorrelationReader,
  type RelayPublicationCorrelationRecord,
  type RelayPublicationEnqueueReceipt,
  type RelayPublicationErrorCode,
  type RelayPublicationIntent,
  type RelayProvisioningErrorCode,
  type RelaySessionCreateRequest,
  type RelaySessionCreationPort,
  type RelaySessionErrorCode,
  type RelaySessionQuery,
  type RelaySessionQueryPort,
  type RelaySessionSteerRequest,
  type RelaySessionSteeringPort,
  type RelaySessionSteerReceipt,
  type RelaySessionStatus,
} from "./index";

const PROVIDER_ID = parseRelayProviderId("whatsapp");
const ACCOUNT_ID = parseRelayAccountId("primary");
const ACCOUNT = { providerId: PROVIDER_ID, accountId: ACCOUNT_ID };
const OTHER_ACCOUNT = {
  providerId: PROVIDER_ID,
  accountId: parseRelayAccountId("secondary"),
};
const COMMUNITY_ADDRESS: RelayAddress = {
  ...ACCOUNT,
  conversationId: parseRelayConversationId("marshal-community"),
};
const OTHER_COMMUNITY_ADDRESS: RelayAddress = {
  ...OTHER_ACCOUNT,
  conversationId: parseRelayConversationId("other-marshal-community"),
};
const WRONG_GROUP_ADDRESS: RelayAddress = {
  ...ACCOUNT,
  conversationId: parseRelayConversationId("wrong-managed-group"),
};

interface ScriptedToolCall {
  readonly toolName: string;
  readonly args: unknown;
}

interface ScriptedTurn {
  readonly expectedText: string;
  readonly calls: readonly ScriptedToolCall[];
  readonly responseText?: string;
}

interface StoredFakeSession {
  readonly request: RelayHostSessionCreateRequest;
  readonly descriptor: RelayHostSessionDescriptor;
}

class FakeClock implements RelayClock {
  constructor(private current = "2026-08-06T21:00:00.000Z") {}

  now(): string {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current = new Date(Date.parse(this.current) + milliseconds).toISOString();
  }
}

class FakeSessionPorts
  implements
    RelaySessionCreationPort,
    RelaySessionQueryPort,
    RelaySessionSteeringPort,
    RelayFixedAgentRuntimePort
{
  private readonly sessions = new Map<string, StoredFakeSession>();
  private readonly sessionByIdempotencyKey = new Map<string, string>();
  private readonly registrations = new Map<string, RelayFixedAgentToolRegistration>();
  private readonly scripts = new Map<RelayFixedAgentRole, ScriptedTurn[]>();
  private readonly historyBySession = new Map<string, Map<string, RelayHostHistoryEntry>>();
  private readonly steeringByIdempotencyKey = new Map<string, RelayHostSessionSteerRequest>();
  readonly createRequests: RelayHostSessionCreateRequest[] = [];
  readonly queryRequests: RelayHostSessionQuery[] = [];
  readonly steeringRequests: RelayHostSessionSteerRequest[] = [];
  leakCrossAccountResults = false;
  private nextSessionId = 1;

  async create(
    request: RelayHostSessionCreateRequest,
  ): Promise<RelayExperienceResult<RelayHostSessionDescriptor, RelaySessionErrorCode>> {
    const existingId = this.sessionByIdempotencyKey.get(request.idempotencyKey);
    if (existingId) {
      const existing = this.requireStored(existingId);
      if (sessionRequestFingerprint(existing.request) !== sessionRequestFingerprint(request)) {
        return failure("idempotency-conflict", "Session request changed for its idempotency key");
      }
      return {
        ok: true,
        value: { ...existing.descriptor, creationDisposition: "deduplicated" },
      };
    }

    const sessionId = `session-${this.nextSessionId++}`;
    const descriptor: RelayHostSessionDescriptor = {
      account: {
        providerId: request.group.providerId,
        accountId: request.group.accountId,
      },
      sessionId,
      kind: request.kind,
      status: "ready",
      priority: request.priority,
      group: request.group,
      ...(request.fixedAgentId ? { fixedAgentId: request.fixedAgentId } : {}),
      createdAt: request.requestedAt,
      updatedAt: request.requestedAt,
      title: request.title,
      ...(request.agentId ? { agentId: request.agentId } : {}),
      persistence: request.lifecycle?.persistence ?? "persistent",
      inspectable: request.lifecycle?.inspectable ?? true,
      retention: request.lifecycle?.retention ?? "ordinary",
      creationDisposition: "created",
    };
    this.sessions.set(sessionId, { request, descriptor });
    this.sessionByIdempotencyKey.set(request.idempotencyKey, sessionId);
    this.createRequests.push(request);
    return { ok: true, value: descriptor };
  }

  async query(
    request: RelayHostSessionQuery,
  ): Promise<RelayExperienceResult<readonly RelayHostSessionDescriptor[], RelaySessionErrorCode>> {
    this.queryRequests.push(request);
    const text = request.text?.toLocaleLowerCase();
    const sessions = [...this.sessions.values()]
      .map((stored) => stored.descriptor)
      .filter(
        (session) =>
          this.leakCrossAccountResults ||
          (session.account.providerId === request.account.providerId &&
            session.account.accountId === request.account.accountId),
      )
      .filter((session) => !request.sessionId || session.sessionId === request.sessionId)
      .filter(
        (session) =>
          !request.group ||
          (session.group?.providerId === request.group.providerId &&
            session.group.accountId === request.group.accountId &&
            session.group.conversationId === request.group.conversationId),
      )
      .filter((session) => !request.kind || session.kind === request.kind)
      .filter((session) => !request.statuses || request.statuses.includes(session.status))
      .filter((session) => !request.inspectableOnly || session.inspectable !== false)
      .filter((session) => !text || (session.title ?? "").toLocaleLowerCase().includes(text))
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.sessionId.localeCompare(right.sessionId),
      );
    return {
      ok: true,
      value: request.limit === undefined ? sessions : sessions.slice(0, request.limit),
    };
  }

  async steer(
    request: RelayHostSessionSteerRequest,
  ): Promise<RelayExperienceResult<RelaySessionSteerReceipt, RelaySessionErrorCode>> {
    const existing = this.steeringByIdempotencyKey.get(request.idempotencyKey);
    if (existing) {
      if (steeringFingerprint(existing) !== steeringFingerprint(request)) {
        return failure("idempotency-conflict", "Steering request changed for its idempotency key");
      }
      return {
        ok: true,
        value: {
          sessionId: existing.sessionId,
          correlationId: existing.correlationId,
          deliveryMode: existing.deliveryMode,
          acceptedAt: existing.requestedAt,
        },
      };
    }
    if (!this.sessions.has(request.sessionId)) {
      return failure("not-found", `Unknown session: ${request.sessionId}`);
    }
    this.steeringByIdempotencyKey.set(request.idempotencyKey, request);
    this.steeringRequests.push(request);
    return {
      ok: true,
      value: {
        sessionId: request.sessionId,
        correlationId: request.correlationId,
        deliveryMode: request.deliveryMode,
        acceptedAt: request.requestedAt,
      },
    };
  }

  async appendHistory(sessionId: string, entry: RelayHostHistoryEntry): Promise<void> {
    this.requireStored(sessionId);
    let entries = this.historyBySession.get(sessionId);
    if (!entries) {
      entries = new Map();
      this.historyBySession.set(sessionId, entries);
    }
    const existing = entries.get(entry.idempotencyKey);
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(
        `History idempotency key was reused with new content: ${entry.idempotencyKey}`,
      );
    }
    entries.set(entry.idempotencyKey, entry);
  }

  async registerTools(
    sessionId: string,
    registration: RelayFixedAgentToolRegistration,
  ): Promise<void> {
    this.requireStored(sessionId);
    this.registrations.set(sessionId, registration);
  }

  async submitNaturalLanguageTurn(
    sessionId: string,
    turn: RelayFixedAgentTurn,
  ): Promise<RelayFixedAgentTurnResult> {
    const stored = this.requireStored(sessionId);
    const role = fixedRoleFromDescriptor(stored.descriptor);
    const script = this.scripts.get(role)?.shift();
    if (!script) throw new Error(`No scripted model decision for ${role}`);
    if (script.expectedText !== turn.text) {
      throw new Error(
        `Expected natural-language turn "${script.expectedText}", received "${turn.text}"`,
      );
    }
    const registration = this.requireRegistration(sessionId);
    const toolResults = await Promise.all(
      script.calls.map(async (call, index) => ({
        toolName: call.toolName,
        result: await registration.invoke(call.toolName, call.args, {
          sessionId,
          toolCallId: `${turn.turnId}:tool-${index + 1}`,
          turn,
        }),
      })),
    );
    return {
      sessionId,
      ...(script.responseText ? { responseText: script.responseText } : {}),
      toolResults,
    };
  }

  queueTurn(role: RelayFixedAgentRole, turn: ScriptedTurn): void {
    const queue = this.scripts.get(role) ?? [];
    queue.push(turn);
    this.scripts.set(role, queue);
  }

  registrationFor(role: RelayFixedAgentRole): RelayFixedAgentToolRegistration {
    return this.requireRegistration(this.sessionFor(role).sessionId);
  }

  sessionFor(role: RelayFixedAgentRole): RelayHostSessionDescriptor {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.descriptor.fixedAgentId === role,
    );
    if (!session) throw new Error(`Fixed-agent session not found: ${role}`);
    return session.descriptor;
  }

  requestFor(sessionId: string): RelayHostSessionCreateRequest {
    return this.requireStored(sessionId).request;
  }

  historyFor(sessionId: string): readonly RelayHostHistoryEntry[] {
    return [...(this.historyBySession.get(sessionId)?.values() ?? [])];
  }

  sessionsByKind(kind: RelayHostSessionDescriptor["kind"]): readonly RelayHostSessionDescriptor[] {
    return [...this.sessions.values()]
      .map((stored) => stored.descriptor)
      .filter((session) => session.kind === kind);
  }

  seedSession(
    title: string,
    status: RelaySessionStatus = "ready",
    retention: RelayHostSessionDescriptor["retention"] = "ordinary",
    account = ACCOUNT,
  ): RelayHostSessionDescriptor {
    const sessionId = `session-${this.nextSessionId++}`;
    const address: RelayAddress = {
      ...account,
      conversationId: parseRelayConversationId(`seed-group-${sessionId}`),
    };
    const request: RelayHostSessionCreateRequest = {
      idempotencyKey: `seed:${account.providerId}:${account.accountId}:${title}`,
      requestedAt: "2026-08-06T20:00:00.000Z",
      group: address,
      kind: "conversation",
      title,
      priority: "foreground",
    };
    const descriptor: RelayHostSessionDescriptor = {
      account,
      sessionId,
      kind: "conversation",
      status,
      priority: "foreground",
      group: address,
      createdAt: request.requestedAt,
      updatedAt: request.requestedAt,
      title,
      persistence: "persistent",
      inspectable: true,
      retention,
      creationDisposition: "created",
    };
    this.sessions.set(sessionId, { request, descriptor });
    this.sessionByIdempotencyKey.set(request.idempotencyKey, sessionId);
    return descriptor;
  }

  deleteDynamicSessions(): readonly string[] {
    const deleted: string[] = [];
    for (const [sessionId, stored] of this.sessions) {
      if (stored.descriptor.retention !== "dynamic") continue;
      this.sessions.delete(sessionId);
      this.sessionByIdempotencyKey.delete(stored.request.idempotencyKey);
      deleted.push(sessionId);
    }
    return deleted;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private requireStored(sessionId: string): StoredFakeSession {
    const stored = this.sessions.get(sessionId);
    if (!stored) throw new Error(`Unknown fake session: ${sessionId}`);
    return stored;
  }

  private requireRegistration(sessionId: string): RelayFixedAgentToolRegistration {
    const registration = this.registrations.get(sessionId);
    if (!registration) throw new Error(`Tools are not registered for ${sessionId}`);
    return registration;
  }
}

interface MutableManagedGroup {
  descriptor: RelayManagedGroupDescriptor;
  groupKey: string;
}

class FakeManagedGroupPort implements RelayFixedAgentManagedGroupPort {
  private readonly groupsByKey = new Map<string, MutableManagedGroup>();
  private readonly bindingsByIdempotencyKey = new Map<string, RelayGroupSessionBinding>();
  readonly createdGroups: RelayManagedGroupDescriptor[] = [];
  readonly ensureRequests: RelayManagedGroupEnsureRequest[] = [];
  readonly bindings: RelayGroupSessionBinding[] = [];
  transformEnsureResult?: (
    request: RelayManagedGroupEnsureRequest,
    group: RelayManagedGroupDescriptor,
  ) => RelayManagedGroupDescriptor;
  private nextGroupId = 1;

  async ensure(
    request: RelayManagedGroupEnsureRequest,
  ): Promise<RelayExperienceResult<RelayManagedGroupEnsureReceipt, RelayProvisioningErrorCode>> {
    this.ensureRequests.push(request);
    const existing = this.groupsByKey.get(request.groupKey);
    if (existing) {
      if (
        existing.descriptor.role !== request.role ||
        existing.descriptor.displayName !== request.displayName
      ) {
        return failure("idempotency-conflict", "Managed group key was reused with new content");
      }
      const reopened = existing.descriptor.state === "retired" && request.reopen;
      if (reopened) {
        existing.descriptor = {
          ...existing.descriptor,
          state: "active",
          updatedAt: request.requestedAt,
        };
      }
      return {
        ok: true,
        value: {
          group: existing.descriptor,
          disposition: reopened ? "reopened" : "existing",
        },
      };
    }

    const descriptor: RelayManagedGroupDescriptor = {
      address: {
        ...request.account,
        conversationId: parseRelayConversationId(`managed-group-${this.nextGroupId++}`),
      },
      communityAddress: request.communityAddress,
      role: request.role,
      displayName: request.displayName,
      state: "active",
      createdAt: request.requestedAt,
      updatedAt: request.requestedAt,
    };
    const returnedDescriptor = this.transformEnsureResult?.(request, descriptor) ?? descriptor;
    this.groupsByKey.set(request.groupKey, {
      descriptor: returnedDescriptor,
      groupKey: request.groupKey,
    });
    this.createdGroups.push(returnedDescriptor);
    return {
      ok: true,
      value: { group: returnedDescriptor, disposition: "created" },
    };
  }

  async bind(
    request: RelayGroupSessionBindingUpsertRequest,
  ): Promise<RelayExperienceResult<RelayGroupSessionBinding, RelayPersistenceErrorCode>> {
    const existing = this.bindingsByIdempotencyKey.get(request.idempotencyKey);
    if (existing) {
      if (
        existing.sessionId !== request.sessionId ||
        existing.role !== request.role ||
        existing.group.conversationId !== request.group.conversationId
      ) {
        return failure("idempotency-conflict", "Group binding changed for its idempotency key");
      }
      return { ok: true, value: existing };
    }
    const binding: RelayGroupSessionBinding = {
      bindingId: request.bindingId ?? `binding-${this.bindings.length + 1}`,
      group: request.group,
      role: request.role,
      sessionId: request.sessionId,
      createdAt: request.requestedAt,
      updatedAt: request.requestedAt,
    };
    this.bindingsByIdempotencyKey.set(request.idempotencyKey, binding);
    this.bindings.push(binding);
    return { ok: true, value: binding };
  }

  groupsForRole(role: RelayManagedGroupRole): readonly RelayManagedGroupDescriptor[] {
    return [...this.groupsByKey.values()]
      .map((stored) => stored.descriptor)
      .filter((group) => group.role === role);
  }

  retireSessionGroup(sessionId: string): void {
    const binding = [...this.bindingsByIdempotencyKey.values()].find(
      (candidate) => candidate.sessionId === sessionId && candidate.role === "session",
    );
    if (!binding) throw new Error(`Session group binding not found: ${sessionId}`);
    const stored = [...this.groupsByKey.values()].find(
      (candidate) => candidate.descriptor.address.conversationId === binding.group.conversationId,
    );
    if (!stored) throw new Error(`Session group not found: ${sessionId}`);
    stored.descriptor = { ...stored.descriptor, state: "retired" };
  }

  groupForSession(sessionId: string): RelayManagedGroupDescriptor | undefined {
    const binding = [...this.bindingsByIdempotencyKey.values()].find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!binding) return undefined;
    return [...this.groupsByKey.values()].find(
      (candidate) => candidate.descriptor.address.conversationId === binding.group.conversationId,
    )?.descriptor;
  }
}

class FakePublicationPorts
  implements RelayPublicationCommandPort, RelayPublicationCorrelationReader
{
  private readonly intentsByIdempotencyKey = new Map<string, RelayPublicationIntent>();
  private readonly correlations = new Map<string, RelayPublicationCorrelationRecord>();
  readonly intents: RelayPublicationIntent[] = [];
  readonly queries: RelayPublicationCorrelationQuery[] = [];
  leakCrossAccountCorrelations = false;

  async enqueue(
    intent: RelayPublicationIntent,
  ): Promise<RelayExperienceResult<RelayPublicationEnqueueReceipt, RelayPublicationErrorCode>> {
    const existing = this.intentsByIdempotencyKey.get(intent.idempotencyKey);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(intent)) {
        return failure(
          "idempotency-conflict",
          "Publication intent changed for its idempotency key",
        );
      }
      return {
        ok: true,
        value: {
          publicationId: existing.request.publicationId,
          correlationId: existing.correlationId,
          disposition: "deduplicated",
          acceptedAt: existing.requestedAt,
        },
      };
    }
    this.intentsByIdempotencyKey.set(intent.idempotencyKey, intent);
    this.intents.push(intent);
    this.correlations.set(intent.correlationId, {
      address: intent.request.address,
      publicationId: intent.request.publicationId,
      providerMessageId: parseRelayMessageId(`published:${intent.request.publicationId}`),
      correlationId: intent.correlationId,
      ...(intent.request.sourceSessionId
        ? { sourceSessionId: intent.request.sourceSessionId }
        : {}),
      ...(intent.request.sourceTurnId ? { sourceTurnId: intent.request.sourceTurnId } : {}),
      ...(intent.progress ? { progress: intent.progress } : {}),
      createdAt: intent.requestedAt,
      publishedAt: intent.requestedAt,
    });
    return {
      ok: true,
      value: {
        publicationId: intent.request.publicationId,
        correlationId: intent.correlationId,
        disposition: "queued",
        acceptedAt: intent.requestedAt,
      },
    };
  }

  async get(
    query: RelayPublicationCorrelationQuery,
  ): Promise<RelayExperienceResult<RelayPublicationCorrelationRecord, RelayPublicationErrorCode>> {
    this.queries.push(query);
    const correlation = this.correlations.get(query.correlationId);
    const accountMatches =
      correlation?.address.providerId === query.account.providerId &&
      correlation.address.accountId === query.account.accountId;
    return correlation && (this.leakCrossAccountCorrelations || accountMatches)
      ? { ok: true, value: correlation }
      : failure("not-found", `Unknown publication correlation: ${query.correlationId}`);
  }

  seedCorrelation(correlation: RelayPublicationCorrelationRecord): void {
    this.correlations.set(correlation.correlationId, correlation);
  }
}

function createHarness(): {
  readonly host: RelayFixedAgentHost;
  readonly sessions: FakeSessionPorts;
  readonly groups: FakeManagedGroupPort;
  readonly publications: FakePublicationPorts;
  readonly clock: FakeClock;
} {
  const sessions = new FakeSessionPorts();
  const groups = new FakeManagedGroupPort();
  const publications = new FakePublicationPorts();
  const clock = new FakeClock();
  return {
    host: new RelayFixedAgentHost({
      account: ACCOUNT,
      communityAddress: COMMUNITY_ADDRESS,
      defaultTaskAgentId: "configured-default-agent",
      catalog: createRelayFixedAgentCatalog(),
      sessionCreation: sessions,
      sessionQuery: sessions,
      sessionSteering: sessions,
      sessionRuntime: sessions,
      managedGroups: groups,
      publicationCommands: publications,
      publicationCorrelations: publications,
      clock,
    }),
    sessions,
    groups,
    publications,
    clock,
  };
}

function makeTurn(
  text: string,
  correlationId: string,
  options: {
    readonly turnId?: string;
    readonly replyToProgressCorrelationId?: string;
    readonly replyToProviderMessageId?: string;
    readonly address?: RelayAddress;
    readonly providerMessageId?: string;
  } = {},
): RelayFixedAgentTurn {
  return {
    turnId: options.turnId ?? `turn-${correlationId}`,
    correlationId,
    text,
    attachments: [],
    receivedAt: "2026-08-06T21:00:00.000Z",
    origin: {
      address: options.address ?? WRONG_GROUP_ADDRESS,
      providerMessageId: parseRelayMessageId(
        options.providerMessageId ?? `message-${correlationId}`,
      ),
    },
    ...(options.replyToProgressCorrelationId
      ? { replyToProgressCorrelationId: options.replyToProgressCorrelationId }
      : {}),
    ...(options.replyToProviderMessageId
      ? { replyToProviderMessageId: parseRelayMessageId(options.replyToProviderMessageId) }
      : {}),
  };
}

function sessionRequestFingerprint(request: RelayHostSessionCreateRequest): string {
  const { requestedAt: _requestedAt, ...stable } = request;
  return JSON.stringify(stable);
}

function steeringFingerprint(request: RelayHostSessionSteerRequest): string {
  const { requestedAt: _requestedAt, ...stable } = request;
  return JSON.stringify(stable);
}

function fixedRoleFromDescriptor(descriptor: RelayHostSessionDescriptor): RelayFixedAgentRole {
  if (
    descriptor.fixedAgentId === "new-chats" ||
    descriptor.fixedAgentId === "progress" ||
    descriptor.fixedAgentId === "information-control"
  ) {
    return descriptor.fixedAgentId;
  }
  throw new Error(`Session is not a fixed agent: ${descriptor.sessionId}`);
}

function failure<Code extends string>(
  code: Code,
  message: string,
): RelayExperienceResult<never, Code> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: false,
    },
  };
}

describe("RelayFixedAgentHost", () => {
  it("locks the canonical catalog, session, steering, and publication port surfaces", () => {
    expectTypeOf<keyof RelayFixedAgentCatalogPort>().toEqualTypeOf<"list" | "get">();
    expectTypeOf<keyof RelaySessionCreationPort>().toEqualTypeOf<"create">();
    expectTypeOf<keyof RelaySessionQueryPort>().toEqualTypeOf<"query">();
    expectTypeOf<keyof RelaySessionSteeringPort>().toEqualTypeOf<"steer">();
    expectTypeOf<keyof RelayPublicationCommandPort>().toEqualTypeOf<"enqueue">();
    expectTypeOf<RelayHostSessionCreateRequest>().toExtend<RelaySessionCreateRequest>();
    expectTypeOf<RelayHostSessionQuery>().toExtend<RelaySessionQuery>();
    expectTypeOf<RelayHostSessionSteerRequest>().toExtend<RelaySessionSteerRequest>();
    expectTypeOf<RelayAccountScope>().toEqualTypeOf<CanonicalRelayAccountScope>();
    expectTypeOf<RelayFixedAgentSpecification>().toEqualTypeOf<CanonicalRelayFixedAgentSpecification>();
    expectTypeOf<RelayManagedGroupRole>().toEqualTypeOf<CanonicalRelayManagedGroupRole>();

    const allowedTool = {
      toolId: RELAY_FIXED_AGENT_TOOL_NAMES.progressRouteReply,
      reason: "Route correlated replies.",
    } satisfies RelayAllowedToolDescriptor;
    const policy = {
      mode: "default-deny",
      allowedTools: [allowedTool],
    } satisfies RelayDefaultDenyToolPolicyDescriptor;
    const specification = {
      agentId: "progress",
      specVersion: 1,
      role: "progress",
      displayName: "Progress",
      description: "Reports deliberate progress.",
      instructions: "Use natural language.",
      sessionPriority: "control",
      toolPolicy: policy,
    } satisfies RelayFixedAgentSpecification;
    expect(specification.role).toBe("progress");
  });

  it("installs the canonical catalog with default-deny tools and cleanup protection", async () => {
    const { host, sessions, groups } = createHarness();
    const installations = await host.initialize();
    expect(await host.initialize()).toEqual(installations);

    expect(installations.map((installation) => installation.specification.role)).toEqual([
      "new-chats",
      "progress",
      "information-control",
    ]);
    expect(relayFixedAgentToolMatrix()).toEqual({
      "new-chats": [
        RELAY_FIXED_AGENT_TOOL_NAMES.newChatsClarify,
        RELAY_FIXED_AGENT_TOOL_NAMES.newChatsStartTask,
      ],
      progress: [RELAY_FIXED_AGENT_TOOL_NAMES.progressRouteReply],
      "information-control": [
        RELAY_FIXED_AGENT_TOOL_NAMES.informationListRecent,
        RELAY_FIXED_AGENT_TOOL_NAMES.informationSearch,
        RELAY_FIXED_AGENT_TOOL_NAMES.informationStatus,
        RELAY_FIXED_AGENT_TOOL_NAMES.informationOpenGroup,
      ],
    });

    for (const installation of installations) {
      expect(installation.specification).toMatchObject({
        agentId: installation.specification.role,
        specVersion: 1,
        sessionPriority: installation.specification.role === "new-chats" ? "foreground" : "control",
        toolPolicy: { mode: "default-deny" },
      });
      expect(installation.lifecycle).toEqual({
        persistence: "persistent",
        inspectable: true,
        retention: "fixed",
        dynamicCleanup: "exclude",
      });
      expect(installation.session).toMatchObject({
        kind: "fixed-agent",
        fixedAgentId: installation.specification.agentId,
        group: installation.group.address,
      });
      expect(installation.group.role).toBe(installation.specification.role);
      const request = sessions.requestFor(installation.session.sessionId);
      expect(request.lifecycle).toEqual(installation.lifecycle);
      const registration = sessions.registrationFor(installation.specification.role);
      expect(registration.policy).toEqual(installation.specification.toolPolicy);
      expect(registration.remotePermissionApproval).toBe("forbidden");
      expect(registration.definitions.map((definition) => definition.name)).toEqual(
        installation.specification.toolPolicy.allowedTools.map((tool) => tool.toolId),
      );
      expect(
        registration.resolveRemotePermission({
          sessionId: installation.session.sessionId,
          providerId: PROVIDER_ID,
          toolName: "permission_approve",
        }),
      ).toEqual({
        decision: "reject",
        reason: "Remote permission approval is forbidden for relay fixed agents",
      });
    }

    expect(groups.groupsForRole("new-chats")).toHaveLength(1);
    expect(groups.groupsForRole("progress")).toHaveLength(1);
    expect(groups.groupsForRole("information-control")).toHaveLength(1);
    expect(groups.ensureRequests.slice(0, 3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: ACCOUNT,
          communityAddress: COMMUNITY_ADDRESS,
          role: "new-chats",
        }),
        expect.objectContaining({
          account: ACCOUNT,
          communityAddress: COMMUNITY_ADDRESS,
          role: "progress",
        }),
        expect.objectContaining({
          account: ACCOUNT,
          communityAddress: COMMUNITY_ADDRESS,
          role: "information-control",
        }),
      ]),
    );
    expect(
      groups.ensureRequests
        .slice(0, 3)
        .every((request) => request.groupKey.includes("whatsapp:primary")),
    ).toBe(true);
    expect(
      sessions.createRequests
        .filter((request) => request.kind === "fixed-agent")
        .every((request) => request.idempotencyKey.includes("whatsapp:primary")),
    ).toBe(true);
    const newChats = sessions.sessionFor("new-chats");
    const newChatsGroup = newChats.group;
    if (!newChatsGroup) throw new Error("New Chats managed group is missing");
    await expect(
      sessions.registrationFor("new-chats").invoke(
        RELAY_FIXED_AGENT_TOOL_NAMES.informationListRecent,
        {},
        {
          sessionId: newChats.sessionId,
          toolCallId: "forbidden-tool-call",
          turn: makeTurn("Show my recent sessions.", "boundary-check", {
            address: newChatsGroup,
          }),
        },
      ),
    ).rejects.toThrow('Relay fixed agent "new-chats" denied tool');

    const dynamic = sessions.seedSession("Temporary relay group", "ready", "dynamic");
    expect(sessions.deleteDynamicSessions()).toEqual([dynamic.sessionId]);
    expect(sessions.hasSession(dynamic.sessionId)).toBe(false);
    for (const installation of installations) {
      expect(sessions.hasSession(installation.session.sessionId)).toBe(true);
    }
  });

  it("rejects fixed-agent groups returned for another canonical scope or role", async () => {
    const { host, groups } = createHarness();
    groups.transformEnsureResult = (request, group) =>
      request.role === "progress"
        ? {
            ...group,
            address: {
              ...OTHER_ACCOUNT,
              conversationId: group.address.conversationId,
            },
            communityAddress: OTHER_COMMUNITY_ADDRESS,
            role: "session",
          }
        : group;

    await expect(host.initialize()).rejects.toThrow(
      "Managed relay group does not match canonical progress scope",
    );
  });

  it("deduplicates clarification replay across changed model toolCallId and creates one task", async () => {
    const { host, sessions, groups, publications } = createHarness();
    await host.initialize();
    const newChatsGroup = sessions.sessionFor("new-chats").group;
    if (!newChatsGroup) throw new Error("New Chats managed group is missing");

    sessions.queueTurn("new-chats", {
      expectedText: "Could you take care of the release?",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.newChatsClarify,
          args: {
            question: "Which release should I prepare, and what outcome do you need?",
          },
        },
      ],
    });
    const clarificationTurn = makeTurn(
      "Could you take care of the release?",
      "request-needs-clarification",
      { address: newChatsGroup },
    );
    const clarification = await host.submitTurn("new-chats", clarificationTurn);
    const replay = await sessions.registrationFor("new-chats").invoke(
      RELAY_FIXED_AGENT_TOOL_NAMES.newChatsClarify,
      {
        question: "Which release should I prepare, and what outcome do you need?",
      },
      {
        sessionId: sessions.sessionFor("new-chats").sessionId,
        toolCallId: "unstable-replayed-tool-call",
        turn: clarificationTurn,
      },
    );
    expect(publications.intents).toEqual([
      expect.objectContaining({
        intent: "deliberate",
        correlationId: "request-needs-clarification",
        request: expect.objectContaining({
          kind: "reply",
          text: "Which release should I prepare, and what outcome do you need?",
          address: newChatsGroup,
        }),
      }),
    ]);
    expect(clarification.toolResults[0]?.result).toMatchObject({
      disposition: "queued",
    });
    expect(replay).toMatchObject({ disposition: "deduplicated" });
    expect(publications.intents[0]?.request.publicationId).not.toContain(
      "unstable-replayed-tool-call",
    );
    expect(sessions.sessionsByKind("conversation")).toHaveLength(0);

    const completedText =
      "Prepare the 0.23 release notes from the merged pull requests and flag breaking changes.";
    const startArgs = {
      title: "Prepare 0.23 release notes",
      request: completedText,
    };
    sessions.queueTurn("new-chats", {
      expectedText: completedText,
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.newChatsStartTask,
          args: startArgs,
        },
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.newChatsStartTask,
          args: startArgs,
        },
      ],
    });
    const result = await host.submitTurn(
      "new-chats",
      makeTurn(completedText, "completed-release-request", {
        address: newChatsGroup,
      }),
    );

    const tasks = sessions.sessionsByKind("conversation");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "Prepare 0.23 release notes",
      agentId: "configured-default-agent",
      persistence: "persistent",
      inspectable: true,
      retention: "ordinary",
    });
    expect(sessions.requestFor(tasks[0]?.sessionId ?? "")).toMatchObject({
      agentId: "configured-default-agent",
      kind: "conversation",
      priority: "foreground",
      lifecycle: {
        persistence: "persistent",
        inspectable: true,
        retention: "ordinary",
      },
    });
    expect(groups.groupsForRole("session")).toEqual([
      expect.objectContaining({
        role: "session",
        displayName: "Prepare 0.23 release notes",
        state: "active",
      }),
    ]);
    expect(
      sessions.steeringRequests.filter((request) => request.sessionId === tasks[0]?.sessionId),
    ).toEqual([
      expect.objectContaining({
        correlationId: "completed-release-request",
        priority: "foreground",
        deliveryMode: "queue",
        input: { text: completedText, attachments: [], transcripts: [] },
      }),
    ]);
    expect(result.toolResults.map((toolResult) => toolResult.result)).toEqual([
      expect.objectContaining({ sessionId: tasks[0]?.sessionId }),
      expect.objectContaining({ sessionId: tasks[0]?.sessionId }),
    ]);
  });

  it("consumes canonical deliberate progress and steers correlated natural replies", async () => {
    const { host, sessions, publications } = createHarness();
    await host.initialize();
    const progressGroup = sessions.sessionFor("progress").group;
    if (!progressGroup) throw new Error("Progress managed group is missing");
    const source = sessions.seedSession("Prepare release notes", "busy");
    const progressInput = {
      publicationId: "publication-progress-1",
      correlationId: "progress-correlation-1",
      sourceSessionId: source.sessionId,
      sourceTurnId: "source-turn-7",
      text: "I found two breaking changes and am checking migration guidance.",
      publishedAt: "2026-08-06T21:00:00.000Z",
      progress: {
        progressId: "progress-1",
        sequence: 1,
        state: "update" as const,
      },
    };

    await host.publishProgress(progressInput);
    await host.publishProgress(progressInput);
    const progressSession = sessions.sessionFor("progress");
    expect(sessions.historyFor(progressSession.sessionId)).toEqual([
      expect.objectContaining({
        kind: "progress-publication",
        correlationId: "progress-correlation-1",
        sourceSessionId: source.sessionId,
        sourceTurnId: "source-turn-7",
      }),
    ]);
    expect(publications.intents).toEqual([
      expect.objectContaining({
        intent: "deliberate",
        correlationId: "progress-correlation-1",
        progress: progressInput.progress,
        request: expect.objectContaining({
          kind: "progress",
          sourceSessionId: source.sessionId,
          sourceTurnId: "source-turn-7",
        }),
      }),
    ]);

    sessions.queueTurn("progress", {
      expectedText: "Please include upgrade examples before you finish.",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.progressRouteReply,
          args: {
            replyKind: "steering",
            message: "Please include upgrade examples before you finish.",
          },
        },
      ],
    });
    await host.submitTurn(
      "progress",
      makeTurn("Please include upgrade examples before you finish.", "progress-reply-steer", {
        replyToProgressCorrelationId: "progress-correlation-1",
        replyToProviderMessageId: "published:publication-progress-1",
        address: progressGroup,
      }),
    );

    sessions.queueTurn("progress", {
      expectedText: "Yes, cover both Windows and macOS.",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.progressRouteReply,
          args: {
            replyKind: "clarification-answer",
            message: "Yes, cover both Windows and macOS.",
          },
        },
      ],
    });
    await host.submitTurn(
      "progress",
      makeTurn("Yes, cover both Windows and macOS.", "progress-reply-answer", {
        replyToProgressCorrelationId: "progress-correlation-1",
        replyToProviderMessageId: "published:publication-progress-1",
        address: progressGroup,
      }),
    );

    const progressReplies = sessions.steeringRequests.filter(
      (request) => request.sessionId === source.sessionId,
    );
    expect(progressReplies).toEqual([
      expect.objectContaining({
        correlationId: "progress-reply-steer",
        source: progressGroup,
        providerMessageId: parseRelayMessageId("message-progress-reply-steer"),
        deliveryMode: "interrupt",
        relayReplyKind: "steering",
        targetTurnId: "source-turn-7",
      }),
      expect.objectContaining({
        correlationId: "progress-reply-answer",
        source: progressGroup,
        providerMessageId: parseRelayMessageId("message-progress-reply-answer"),
        deliveryMode: "queue",
        relayReplyKind: "clarification-answer",
        targetTurnId: "source-turn-7",
      }),
    ]);

    sessions.queueTurn("progress", {
      expectedText: "Send this somewhere else.",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.progressRouteReply,
          args: {
            replyKind: "steering",
            message: "Send this somewhere else.",
          },
        },
      ],
    });
    await expect(
      host.submitTurn(
        "progress",
        makeTurn("Send this somewhere else.", "progress-reply-unknown", {
          replyToProgressCorrelationId: "unknown-progress",
          address: progressGroup,
        }),
      ),
    ).rejects.toThrow("No deliberately published progress for unknown-progress");
  });

  it("validates progress account, reply address, and provider message before steering", async () => {
    const { host, sessions } = createHarness();
    await host.initialize();
    const progressSession = sessions.sessionFor("progress");
    const progressGroup = progressSession.group;
    if (!progressGroup) throw new Error("Progress managed group is missing");
    const source = sessions.seedSession("Scoped progress source", "busy");
    await host.publishProgress({
      publicationId: "publication-origin-check",
      correlationId: "progress-origin-check",
      sourceSessionId: source.sessionId,
      sourceTurnId: "source-turn-origin-check",
      text: "Waiting for confirmation.",
      publishedAt: "2026-08-06T21:00:00.000Z",
      progress: {
        progressId: "progress-origin-check",
        sequence: 1,
        state: "update",
      },
    });

    const registration = sessions.registrationFor("progress");
    await expect(
      registration.invoke(
        RELAY_FIXED_AGENT_TOOL_NAMES.progressRouteReply,
        { replyKind: "steering", message: "Continue with the safer option." },
        {
          sessionId: progressSession.sessionId,
          toolCallId: "progress-wrong-group",
          turn: makeTurn("Continue with the safer option.", "wrong-progress-origin", {
            address: WRONG_GROUP_ADDRESS,
            replyToProgressCorrelationId: "progress-origin-check",
            replyToProviderMessageId: "published:publication-origin-check",
          }),
        },
      ),
    ).rejects.toThrow("Progress reply origin does not match correlation progress-origin-check");

    await expect(
      registration.invoke(
        RELAY_FIXED_AGENT_TOOL_NAMES.progressRouteReply,
        { replyKind: "steering", message: "Continue with the safer option." },
        {
          sessionId: progressSession.sessionId,
          toolCallId: "progress-wrong-provider-message",
          turn: makeTurn("Continue with the safer option.", "wrong-progress-provider", {
            address: progressGroup,
            replyToProgressCorrelationId: "progress-origin-check",
            replyToProviderMessageId: "published:another-progress-publication",
          }),
        },
      ),
    ).rejects.toThrow(
      "Progress reply provider message does not match correlation progress-origin-check",
    );
    expect(
      sessions.steeringRequests.filter((request) => request.sessionId === source.sessionId),
    ).toHaveLength(0);
  });

  it("prevents a leaked correlation from another account from steering", async () => {
    const { host, sessions, publications } = createHarness();
    await host.initialize();
    const progressSession = sessions.sessionFor("progress");
    const progressGroup = progressSession.group;
    if (!progressGroup) throw new Error("Progress managed group is missing");
    const source = sessions.seedSession("Scoped progress source", "busy");
    const registration = sessions.registrationFor("progress");
    publications.leakCrossAccountCorrelations = true;
    publications.seedCorrelation({
      address: {
        ...OTHER_ACCOUNT,
        conversationId: parseRelayConversationId("foreign-progress-group"),
      },
      publicationId: "foreign-progress-publication",
      providerMessageId: parseRelayMessageId("published:foreign-progress-publication"),
      correlationId: "foreign-progress-correlation",
      sourceSessionId: source.sessionId,
      sourceTurnId: "foreign-source-turn",
      progress: {
        progressId: "foreign-progress",
        sequence: 1,
        state: "update",
      },
      createdAt: "2026-08-06T21:00:00.000Z",
      publishedAt: "2026-08-06T21:00:00.000Z",
    });
    await expect(
      registration.invoke(
        RELAY_FIXED_AGENT_TOOL_NAMES.progressRouteReply,
        { replyKind: "clarification-answer", message: "Use the first option." },
        {
          sessionId: progressSession.sessionId,
          toolCallId: "progress-cross-account",
          turn: makeTurn("Use the first option.", "cross-account-progress-reply", {
            address: progressGroup,
            replyToProgressCorrelationId: "foreign-progress-correlation",
            replyToProviderMessageId: "published:foreign-progress-publication",
          }),
        },
      ),
    ).rejects.toThrow(
      "Relay correlation foreign-progress-correlation belongs to another account or group",
    );
    expect(
      publications.queries.every(
        (query) =>
          query.account.providerId === ACCOUNT.providerId &&
          query.account.accountId === ACCOUNT.accountId,
      ),
    ).toBe(true);
    expect(
      sessions.steeringRequests.filter((request) => request.sessionId === source.sessionId),
    ).toHaveLength(0);
  });

  it("queries recent sessions and ensures or reopens canonical session-role groups", async () => {
    const { host, sessions, groups } = createHarness();
    await host.initialize();
    const informationGroup = sessions.sessionFor("information-control").group;
    if (!informationGroup) throw new Error("Information & Control managed group is missing");
    const release = sessions.seedSession("Release readiness", "busy");
    sessions.seedSession("Customer research notes", "ready");

    sessions.queueTurn("information-control", {
      expectedText: "What have I been working on recently?",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.informationListRecent,
          args: { limit: 10 },
        },
      ],
    });
    const recent = await host.submitTurn(
      "information-control",
      makeTurn("What have I been working on recently?", "information-list", {
        address: informationGroup,
      }),
    );
    expect(recent.toolResults[0]?.result).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ title: "New Chats", fixedAgentId: "new-chats" }),
        expect.objectContaining({ title: "Progress", fixedAgentId: "progress" }),
        expect.objectContaining({
          title: "Information & Control",
          fixedAgentId: "information-control",
        }),
        expect.objectContaining({ title: "Release readiness" }),
      ]),
    });

    sessions.queueTurn("information-control", {
      expectedText: "Find the release session.",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.informationSearch,
          args: { query: "release", limit: 5 },
        },
      ],
    });
    const search = await host.submitTurn(
      "information-control",
      makeTurn("Find the release session.", "information-search", {
        address: informationGroup,
      }),
    );
    expect(search.toolResults[0]?.result).toMatchObject({
      sessions: [
        expect.objectContaining({
          sessionId: release.sessionId,
          title: "Release readiness",
        }),
      ],
    });

    sessions.queueTurn("information-control", {
      expectedText: "Is that release session still running?",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.informationStatus,
          args: { sessionId: release.sessionId },
        },
      ],
    });
    const status = await host.submitTurn(
      "information-control",
      makeTurn("Is that release session still running?", "information-status", {
        address: informationGroup,
      }),
    );
    expect(status.toolResults[0]?.result).toMatchObject({
      found: true,
      session: { sessionId: release.sessionId, status: "busy" },
    });

    sessions.queueTurn("information-control", {
      expectedText: "Open its conversation for me.",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.informationOpenGroup,
          args: {
            sessionId: release.sessionId,
            message: "Contact the user in the newly opened access point.",
          },
        },
      ],
    });
    const opened = await host.submitTurn(
      "information-control",
      makeTurn("Open its conversation for me.", "information-open", {
        address: informationGroup,
      }),
    );
    expect(opened.toolResults[0]?.result).toMatchObject({
      sessionId: release.sessionId,
      disposition: "created",
      role: "session",
      contactRequested: true,
      contactDeliveryMode: "interrupt",
    });
    expect(sessions.steeringRequests.at(-1)).toMatchObject({
      sessionId: release.sessionId,
      deliveryMode: "interrupt",
    });
    groups.retireSessionGroup(release.sessionId);

    sessions.queueTurn("information-control", {
      expectedText: "That conversation was archived; please reopen it.",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.informationOpenGroup,
          args: { sessionId: release.sessionId },
        },
      ],
    });
    const reopened = await host.submitTurn(
      "information-control",
      makeTurn("That conversation was archived; please reopen it.", "information-reopen", {
        address: informationGroup,
      }),
    );
    expect(reopened.toolResults[0]?.result).toMatchObject({
      sessionId: release.sessionId,
      disposition: "reopened",
      role: "session",
    });
    expect(groups.groupForSession(release.sessionId)).toMatchObject({
      state: "active",
      role: "session",
    });
  });

  it("filters cross-account list search status results and refuses foreign session open", async () => {
    const { host, sessions, groups } = createHarness();
    await host.initialize();
    const informationGroup = sessions.sessionFor("information-control").group;
    if (!informationGroup) throw new Error("Information & Control managed group is missing");
    sessions.seedSession("Local release plan", "busy");
    const foreign = sessions.seedSession(
      "Foreign release secrets",
      "busy",
      "ordinary",
      OTHER_ACCOUNT,
    );
    sessions.leakCrossAccountResults = true;
    const queryStart = sessions.queryRequests.length;

    sessions.queueTurn("information-control", {
      expectedText: "Show recent work.",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.informationListRecent,
          args: { limit: 20 },
        },
      ],
    });
    const recent = await host.submitTurn(
      "information-control",
      makeTurn("Show recent work.", "cross-account-list", {
        address: informationGroup,
      }),
    );
    expect(JSON.stringify(recent.toolResults[0]?.result)).not.toContain(foreign.sessionId);

    sessions.queueTurn("information-control", {
      expectedText: "Find release sessions.",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.informationSearch,
          args: { query: "release", limit: 20 },
        },
      ],
    });
    const search = await host.submitTurn(
      "information-control",
      makeTurn("Find release sessions.", "cross-account-search", {
        address: informationGroup,
      }),
    );
    expect(JSON.stringify(search.toolResults[0]?.result)).not.toContain(foreign.sessionId);

    sessions.queueTurn("information-control", {
      expectedText: "What is the foreign session doing?",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.informationStatus,
          args: { sessionId: foreign.sessionId },
        },
      ],
    });
    const status = await host.submitTurn(
      "information-control",
      makeTurn("What is the foreign session doing?", "cross-account-status", {
        address: informationGroup,
      }),
    );
    expect(status.toolResults[0]?.result).toEqual({
      found: false,
      sessionId: foreign.sessionId,
    });

    const sessionGroupsBefore = groups.groupsForRole("session").length;
    sessions.queueTurn("information-control", {
      expectedText: "Open the foreign session.",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.informationOpenGroup,
          args: { sessionId: foreign.sessionId },
        },
      ],
    });
    await expect(
      host.submitTurn(
        "information-control",
        makeTurn("Open the foreign session.", "cross-account-open", {
          address: informationGroup,
        }),
      ),
    ).rejects.toThrow(`Inspectable session not found: ${foreign.sessionId}`);
    expect(groups.groupsForRole("session")).toHaveLength(sessionGroupsBefore);
    expect(
      sessions.queryRequests
        .slice(queryStart)
        .every(
          (query) =>
            query.account.providerId === ACCOUNT.providerId &&
            query.account.accountId === ACCOUNT.accountId,
        ),
    ).toBe(true);
  });

  it("rejects open group ensure results from a foreign account or community", async () => {
    const { host, sessions, groups } = createHarness();
    await host.initialize();
    const informationGroup = sessions.sessionFor("information-control").group;
    if (!informationGroup) throw new Error("Information & Control managed group is missing");
    const local = sessions.seedSession("Local scoped session", "ready");
    const bindingsBefore = groups.bindings.length;
    groups.transformEnsureResult = (request, group) =>
      request.role === "session"
        ? {
            ...group,
            address: {
              ...OTHER_ACCOUNT,
              conversationId: group.address.conversationId,
            },
            communityAddress: OTHER_COMMUNITY_ADDRESS,
          }
        : group;

    sessions.queueTurn("information-control", {
      expectedText: "Open the local scoped session.",
      calls: [
        {
          toolName: RELAY_FIXED_AGENT_TOOL_NAMES.informationOpenGroup,
          args: { sessionId: local.sessionId },
        },
      ],
    });
    await expect(
      host.submitTurn(
        "information-control",
        makeTurn("Open the local scoped session.", "foreign-group-result", {
          address: informationGroup,
        }),
      ),
    ).rejects.toThrow("Managed relay group does not match canonical session scope");
    expect(groups.bindings).toHaveLength(bindingsBefore);
  });

  it("records the canonical tool-policy gap while keeping prompts transport-neutral", async () => {
    const catalog = createRelayFixedAgentCatalog();
    await expect(catalog.get("progress")).resolves.toEqual({
      ok: true,
      value: RELAY_FIXED_AGENT_SPECIFICATIONS[1],
    });
    await expect(catalog.get("missing-agent")).resolves.toMatchObject({
      ok: false,
      error: { code: "not-found", retryable: false },
    });
    expect(RELAY_FIXED_AGENT_TOOL_POLICY_MISMATCHES).toEqual([
      {
        mismatchId: "remote-permission-approval-not-represented",
        affectedRoles: ["new-chats", "progress", "information-control"],
        canonicalDescriptor: "RelayDefaultDenyToolPolicyDescriptor",
        hostRequirement: "remote-permission-approval-forbidden",
        enforcement: "RelayFixedAgentToolRegistration.resolveRemotePermission",
      },
    ]);
    for (const specification of RELAY_FIXED_AGENT_SPECIFICATIONS) {
      expect(specification.instructions).toMatch(/natural\s+language/);
      expect(specification.instructions).not.toContain("/start");
      expect(specification.instructions).not.toContain("whatsapp");
      expect(specification.toolPolicy.mode).toBe("default-deny");
      expect(specification.toolPolicy.allowedTools.length).toBeGreaterThan(0);
    }
  });
});
