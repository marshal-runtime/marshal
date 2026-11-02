import { randomUUID } from "node:crypto";

import {
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type InvocationContext,
  type RuntimeCatalogEntry,
  type RuntimeCatalogProvider,
  type RuntimeHostProviderSource,
  type RuntimeResourceDescriptor,
  type RuntimeScopedResourcePort,
  type RuntimeServiceContainer,
} from "@marshal/runtime";

import type { RuntimeUiOwner } from "../../common/runtime-ui";
import type { RuntimeTool } from "../backend/runtime-contract";
import type { MarshalRuntimeAgentPort, MarshalRuntimeAgentSummary } from "./agent-orchestration";
import { createRuntimeAgentProvider } from "./agent-provider";
import { createRuntimeBrainProvider, type MarshalRuntimeBrainPort } from "./brain-provider";
import {
  MARSHAL_RUNTIME_PERMISSION,
  MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX,
  type MarshalRuntimeCatalogPort,
  type MarshalRuntimeScope,
} from "./contracts";
import { createRuntimeMemoryProvider, type MarshalRuntimeMemoryPort } from "./runtime-memory";
import { MarshalServiceSymbols } from "./service-symbols";
import {
  type MarshalAgentsService,
  type MarshalBrainService,
  type MarshalCatalogService,
  type MarshalMemoryService,
  type MarshalRuntimeToolDescriptor,
} from "./service-symbols";
import type { MarshalRuntimeUiController } from "./ui-controller";
import { createRuntimeUiProvider, type ListAuthoredUiApplications } from "./ui-providers";

const TOOL_PROVIDER_ID = "marshal.host-tools";
const CONTEXT_PROVIDER_ID = "marshal.host-context";
const SKILL_CATALOG_ID = "marshal.skill-catalog";
const TOOL_CAPABILITY_PREFIX = "marshal.tool.";
const SKILL_RESOURCE_PREFIX = "marshal-skill://skill/";
const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["content"],
  properties: { content: { type: "string" } },
} as const;
const SESSION_CONTEXT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["session"],
  properties: {
    session: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["id", "name"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            workspaceName: { type: "string" },
            repoPath: { type: "string" },
            source: { type: "string" },
          },
        },
      ],
    },
  },
} as const;
const WORKSPACE_LIST_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["workspaces"],
  properties: {
    workspaces: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "path"],
        properties: {
          name: { type: "string" },
          path: { type: "string" },
        },
      },
    },
  },
} as const;
const SKILL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skill"],
  properties: {
    skill: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["instructions", "resourceDir"],
          properties: {
            instructions: { type: "string" },
            resourceDir: { type: ["string", "null"] },
          },
        },
      ],
    },
  },
} as const;

function sessionId(context: InvocationContext | undefined): string {
  const value = context ? scopedSessionId(context) : null;
  if (!value) throw new Error("Marshal Runtime invocation requires a session scope.");
  return value;
}

function scopedSessionId(context: InvocationContext): string | null {
  const value = context.scope?.sessionId?.trim();
  return value || null;
}

function abortSignal(context: InvocationContext): AbortSignal | undefined {
  const signal = context.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

const NATIVE_MEMORY_TOOLS: ReadonlySet<string> = new Set([
  "remember",
  "recall",
  "listMemories",
  "forget",
]);

function toolCapabilityName(toolName: string): string {
  return `${TOOL_CAPABILITY_PREFIX}${toolName}`;
}

function toolNameFromCapability(capability: string): string | null {
  return capability.startsWith(TOOL_CAPABILITY_PREFIX)
    ? capability.slice(TOOL_CAPABILITY_PREFIX.length)
    : null;
}

function toolDescriptor(tool: RuntimeTool): CapabilityDescriptor {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: toolCapabilityName(tool.name),
    version: "1.0.0",
    title: tool.name,
    description: tool.description?.trim() || `Invoke the Marshal host tool "${tool.name}".`,
    tags: [
      "marshal",
      "host",
      "tool",
      // Agents already call these as native tools; the mirror is for scripts by exact name.
      ...(NATIVE_MEMORY_TOOLS.has(tool.name) ? ["internal"] : []),
    ],
    inputSchema: tool.parameters ?? { type: "object", additionalProperties: true },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    permissions: [
      {
        permission: `${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}${tool.name}`,
        reason: `Invokes the Marshal host tool "${tool.name}" under its session policy.`,
        risk: "medium",
      },
    ],
  };
}

function createToolProvider(port: MarshalRuntimeCatalogPort): CapabilityProvider {
  const tools = (context: InvocationContext): readonly RuntimeTool[] => {
    const currentSessionId = scopedSessionId(context);
    if (!currentSessionId) return [];
    const listed = port.listTools(currentSessionId);
    const names = new Set<string>();
    for (const tool of listed) {
      if (names.has(tool.name)) throw new Error(`Duplicate Marshal host tool "${tool.name}".`);
      names.add(tool.name);
    }
    port.onToolsListed?.(listed);
    return listed;
  };
  return {
    id: TOOL_PROVIDER_ID,
    version: "1.0.0",
    list: (context) => tools(context).map(toolDescriptor),
    get: (name, context) => {
      const toolName = toolNameFromCapability(name);
      const tool = toolName ? tools(context).find((entry) => entry.name === toolName) : undefined;
      return tool ? toolDescriptor(tool) : undefined;
    },
    async invoke(name, input, context) {
      const toolName = toolNameFromCapability(name);
      const tool = toolName ? tools(context).find((entry) => entry.name === toolName) : undefined;
      if (!tool)
        throw Object.assign(new Error(`Marshal host tool not found: ${name}.`), {
          code: "not_found",
        });
      const invocationSignal = abortSignal(context);
      const args = input ?? {};
      port.onToolInvoked?.(tool);
      const output = await tool.handler(args, {
        sessionId: sessionId(context),
        toolCallId: context.executionId ?? randomUUID(),
        toolName: tool.name,
        arguments: args,
        ...(invocationSignal ? { signal: invocationSignal } : {}),
      });
      return { output: { content: output } };
    },
  };
}

const CONTEXT_DESCRIPTORS: readonly CapabilityDescriptor[] = [
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: "marshal.session.context",
    version: "1.0.0",
    title: "Read current Marshal session context",
    description: "Returns bounded metadata for the authority-scoped Marshal session.",
    tags: ["marshal", "session", "context"],
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: SESSION_CONTEXT_OUTPUT_SCHEMA,
    permissions: [{ permission: MARSHAL_RUNTIME_PERMISSION.sessionRead, risk: "low" }],
  },
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: "marshal.workspace.list",
    version: "1.0.0",
    title: "List registered Marshal workspaces",
    description: "Lists the workspaces registered in the current Marshal installation.",
    tags: ["marshal", "workspace", "context"],
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: WORKSPACE_LIST_OUTPUT_SCHEMA,
    permissions: [{ permission: MARSHAL_RUNTIME_PERMISSION.workspaceRead, risk: "low" }],
  },
  {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: "marshal.skill.read",
    version: "1.0.0",
    title: "Read a Marshal skill resource",
    description: "Reads the instructions for one skill visible to the current session.",
    tags: ["marshal", "skill", "resource"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string", minLength: 1, maxLength: 256 } },
    },
    outputSchema: SKILL_OUTPUT_SCHEMA,
    permissions: [{ permission: MARSHAL_RUNTIME_PERMISSION.skillRead, risk: "low" }],
  },
];

function createContextProvider(port: MarshalRuntimeCatalogPort): CapabilityProvider {
  return {
    id: CONTEXT_PROVIDER_ID,
    version: "1.0.0",
    list: () => CONTEXT_DESCRIPTORS,
    get: (name) => CONTEXT_DESCRIPTORS.find((descriptor) => descriptor.name === name),
    async invoke(name, input, context) {
      if (name === "marshal.session.context") {
        return {
          output: {
            session: await port.getSessionContext(
              sessionId(context),
              abortSignal(context),
              context,
            ),
          },
        };
      }
      if (name === "marshal.workspace.list") {
        return { output: { workspaces: await port.listWorkspaces(context) } };
      }
      if (name === "marshal.skill.read") {
        const skillName =
          typeof input === "object" && input !== null && !Array.isArray(input)
            ? Reflect.get(input, "name")
            : undefined;
        if (typeof skillName !== "string" || !skillName.trim()) {
          throw new TypeError("marshal.skill.read requires a non-empty skill name.");
        }
        return {
          output: {
            skill: await port.getSkill(sessionId(context), skillName.trim(), context),
          },
        };
      }
      throw Object.assign(new Error(`Marshal host capability not found: ${name}.`), {
        code: "not_found",
      });
    },
  };
}

function skillResourceUri(name: string): string {
  return `${SKILL_RESOURCE_PREFIX}${encodeURIComponent(name)}`;
}

/** Match name-based skill reads: the first visible provider entry wins. */
async function uniqueVisibleSkills(
  port: MarshalRuntimeCatalogPort,
  currentSessionId: string,
  context: InvocationContext,
): Promise<Awaited<ReturnType<MarshalRuntimeCatalogPort["listSkills"]>>> {
  const seen = new Set<string>();
  return (await port.listSkills(currentSessionId, context)).filter((skill) => {
    if (seen.has(skill.name)) return false;
    seen.add(skill.name);
    return true;
  });
}

function createSkillResources(port: MarshalRuntimeCatalogPort): RuntimeScopedResourcePort {
  return {
    async listResources(context): Promise<readonly RuntimeResourceDescriptor[]> {
      const currentSessionId = scopedSessionId(context);
      if (!currentSessionId) return [];
      const uniqueSkills = await uniqueVisibleSkills(port, currentSessionId, context);
      return uniqueSkills.map((skill) => ({
        uri: skillResourceUri(skill.name),
        name: skill.displayName ?? skill.name,
        description: skill.description,
        mimeType: "text/markdown",
        catalog: {
          owner: { type: "provider", id: SKILL_CATALOG_ID },
          metadata: { skillName: skill.name, scope: skill.scope },
        },
      }));
    },
    async readResource(uri, context) {
      if (!uri.startsWith(SKILL_RESOURCE_PREFIX)) {
        throw Object.assign(new Error(`Marshal skill resource not found: ${uri}.`), {
          code: "not_found",
        });
      }
      const name = decodeURIComponent(uri.slice(SKILL_RESOURCE_PREFIX.length));
      const skill = await port.getSkill(sessionId(context), name, context);
      if (!skill) {
        throw Object.assign(new Error(`Marshal skill resource not found: ${name}.`), {
          code: "not_found",
        });
      }
      return { uri, mimeType: "text/markdown", text: skill.instructions };
    },
  };
}

function createSkillCatalog(port: MarshalRuntimeCatalogPort): RuntimeCatalogProvider {
  const entry = (
    skill: Awaited<ReturnType<MarshalRuntimeCatalogPort["listSkills"]>>[number],
  ): RuntimeCatalogEntry => ({
    id: `catalog://${SKILL_CATALOG_ID}/${encodeURIComponent(skill.name)}`,
    kind: "skill",
    title: skill.displayName ?? skill.name,
    description: skill.description,
    tags: ["marshal", "skill", skill.scope],
    action: { type: "resource_read", uri: skillResourceUri(skill.name) },
    metadata: { skillName: skill.name, scope: skill.scope },
  });
  return {
    id: SKILL_CATALOG_ID,
    list: async (context) => {
      const currentSessionId = scopedSessionId(context);
      return currentSessionId
        ? (await uniqueVisibleSkills(port, currentSessionId, context)).map(entry)
        : [];
    },
    get: async (id, context) => {
      const currentSessionId = scopedSessionId(context);
      if (!currentSessionId) return undefined;
      return (await uniqueVisibleSkills(port, currentSessionId, context))
        .map(entry)
        .find((candidate) => candidate.id === id);
    },
  };
}

export function createMarshalHostProviderSource(
  services: RuntimeServiceContainer,
  ui?: MarshalRuntimeUiController,
  resolveApplicationOwner?: (context: InvocationContext) => RuntimeUiOwner | undefined,
  listAuthoredApplications?: ListAuthoredUiApplications,
): RuntimeHostProviderSource {
  const port = callTimeCatalogPort(services);
  const agents = services.tryGet(MarshalServiceSymbols.agents)
    ? createCallTimeAgentPort(services)
    : undefined;
  const memory = services.tryGet(MarshalServiceSymbols.memory)
    ? callTimeMemoryPort(services)
    : undefined;
  const brain = services.tryGet(MarshalServiceSymbols.brain)
    ? callTimeBrainPort(services)
    : undefined;
  return () => ({
    providers: [
      createToolProvider(port),
      createContextProvider(port),
      ...(agents ? [createRuntimeAgentProvider(agents)] : []),
      ...(brain ? [createRuntimeBrainProvider(brain)] : []),
      ...(memory ? [createRuntimeMemoryProvider(memory)] : []),
      ...(ui
        ? [createRuntimeUiProvider(ui, services, resolveApplicationOwner, listAuthoredApplications)]
        : []),
    ],
    resources: createSkillResources(port),
    catalog: createSkillCatalog(port),
  });
}

function callTimeCatalogPort(services: RuntimeServiceContainer): MarshalRuntimeCatalogPort {
  return {
    listTools: (currentSessionId) =>
      services.get(MarshalServiceSymbols.catalog).listNativeTools(currentSessionId),
    onToolsListed: (tools) => services.get(MarshalServiceSymbols.catalog).onToolsListed?.(tools),
    onToolInvoked: (tool) => services.get(MarshalServiceSymbols.catalog).onToolInvoked?.(tool),
    listSkills: (_currentSessionId, context) =>
      services
        .get(MarshalServiceSymbols.catalog)
        .listSkills({}, requiredContext(context))
        .then((result) => result.skills),
    getSkill: (_currentSessionId, name, context) =>
      services
        .get(MarshalServiceSymbols.catalog)
        .getSkill({ name }, requiredContext(context))
        .then((result) => result.skill),
    listWorkspaces: (context) =>
      services
        .get(MarshalServiceSymbols.catalog)
        .listWorkspaces({}, requiredContext(context))
        .then((result) => result.workspaces),
    getSessionContext: (_currentSessionId, signal, context) =>
      services
        .get(MarshalServiceSymbols.catalog)
        .getSessionContext(
          {},
          {
            ...requiredContext(context),
            ...(signal ? { signal } : {}),
          },
        )
        .then((result) => result.session),
  };
}

function requiredContext(context: InvocationContext | undefined): InvocationContext {
  if (!context) throw new Error("Marshal Runtime service invocation requires context.");
  return context;
}

export function createCallTimeAgentPort(
  services: RuntimeServiceContainer,
): MarshalRuntimeAgentPort {
  return {
    launch: ({ scope, signal, runtimeDelegationId, runtimeTaskController, ...input }) => {
      const context = contextFor(scope, signal);
      return services
        .get(MarshalServiceSymbols.agents)
        .launch(input, {
          ...context,
          metadata: {
            ...context.metadata,
            ...(runtimeDelegationId ? { marshalLaunchDelegationId: runtimeDelegationId } : {}),
            ...(runtimeTaskController
              ? {
                  marshalLaunchTaskController: runtimeTaskController,
                  runtimeExtensionIdentity: runtimeTaskController,
                }
              : {}),
          },
        })
        .then((result) => result.agent);
    },
    list: (scope, signal) =>
      services
        .get(MarshalServiceSymbols.agents)
        .list({}, contextFor(scope, signal))
        .then((result) => result.agents),
    get: (scope, agentId, signal) =>
      services
        .get(MarshalServiceSymbols.agents)
        .get({ agentId }, contextFor(scope, signal))
        .then((result) => result.agent),
    send: (scope, agentId, message, deliveryMode, signal) =>
      services
        .get(MarshalServiceSymbols.agents)
        .send({ agentId, message, deliveryMode }, contextFor(scope, signal)),
    transcript: (scope, agentId, limit, signal) =>
      services
        .get(MarshalServiceSymbols.agents)
        .transcript(
          { agentId, ...(limit === undefined ? {} : { limit }) },
          contextFor(scope, signal),
        ),
    wait: (scope, agentId, options) =>
      services.get(MarshalServiceSymbols.agents).wait(
        {
          agentId,
          ...(options?.messageId === undefined ? {} : { messageId: options.messageId }),
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
        contextFor(scope, options?.signal),
      ),
    cancel: (scope, agentId, signal) =>
      services
        .get(MarshalServiceSymbols.agents)
        .cancel({ agentId }, contextFor(scope, signal))
        .then((result) => result.agent),
    setModel: (scope, agentId, model, reasoningEffort, signal) =>
      services
        .get(MarshalServiceSymbols.agents)
        .setModel(
          { agentId, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
          contextFor(scope, signal),
        )
        .then((result) => result.agent),
  };
}

function callTimeMemoryPort(services: RuntimeServiceContainer): MarshalRuntimeMemoryPort {
  return {
    store: (scope, fact, category, signal) =>
      services
        .get(MarshalServiceSymbols.memory)
        .store({ fact, category }, contextFor(scope, signal)),
    recall: (scope, query, limit, signal) =>
      services
        .get(MarshalServiceSymbols.memory)
        .recall({ query, limit }, contextFor(scope, signal)),
  };
}

function callTimeBrainPort(services: RuntimeServiceContainer): MarshalRuntimeBrainPort {
  return {
    launch: (request) => {
      const input = {
        ...(request.task === undefined ? {} : { task: request.task }),
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort }),
        ...(request.soul === undefined ? {} : { soul: request.soul }),
      };
      return services
        .get(MarshalServiceSymbols.brain)
        .launch(input, contextFor(request.scope, request.signal))
        .then((result) => result.agent);
    },
    get: (scope, signal) =>
      services
        .get(MarshalServiceSymbols.brain)
        .get({}, contextFor(scope, signal))
        .then((result) => result.agent),
    send: (scope, message, deliveryMode, signal) =>
      services
        .get(MarshalServiceSymbols.brain)
        .send(
          { message, ...(deliveryMode === undefined ? {} : { deliveryMode }) },
          contextFor(scope, signal),
        ),
    transcript: (scope, limit, signal) =>
      services
        .get(MarshalServiceSymbols.brain)
        .transcript({ ...(limit === undefined ? {} : { limit }) }, contextFor(scope, signal)),
    wait: (scope, options) =>
      services.get(MarshalServiceSymbols.brain).wait(
        {
          ...(options?.messageId === undefined ? {} : { messageId: options.messageId }),
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        },
        contextFor(scope, options?.signal),
      ),
    cancel: (scope, signal) =>
      services
        .get(MarshalServiceSymbols.brain)
        .cancel({}, contextFor(scope, signal))
        .then((result) => result.agent),
  };
}

function contextFor(scope: MarshalRuntimeScope, signal?: AbortSignal): InvocationContext {
  const scopeRuntimeId = Reflect.get(scope, "runtimeId");
  const runtimeId =
    typeof scopeRuntimeId === "string" && scopeRuntimeId.trim() ? scopeRuntimeId.trim() : undefined;
  const scopeBackendOrigin = Reflect.get(scope, "backendOrigin");
  const backendOrigin =
    scopeBackendOrigin === "copilot" || scopeBackendOrigin === "gateway"
      ? scopeBackendOrigin
      : undefined;
  const runtimeIdentity = {
    ...(runtimeId ? { runtimeId } : {}),
    ...(backendOrigin ? { backendOrigin } : {}),
  };
  return {
    principal: { id: "marshal-runtime-host", kind: "agent" },
    scope: {
      sessionId: scope.sessionId,
      workspaceName: scope.workspaceName,
      ...runtimeIdentity,
    },
    ...(signal ? { signal } : {}),
    metadata: {
      marshalWorkspaceName: scope.workspaceName,
      ...runtimeIdentity,
    },
  };
}

export function createRuntimeAgentService(port: MarshalRuntimeAgentPort): MarshalAgentsService {
  const provider = createRuntimeAgentProvider(port);
  return {
    launch: (input, context) =>
      invokeProvider<{ readonly agent: MarshalRuntimeAgentSummary }>(
        provider,
        "marshal.agent.launch",
        input,
        context,
      ),
    list: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalAgentsService["list"]>>>(
        provider,
        "marshal.agent.list",
        input,
        context,
      ),
    get: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalAgentsService["get"]>>>(
        provider,
        "marshal.agent.get",
        input,
        context,
      ),
    send: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalAgentsService["send"]>>>(
        provider,
        "marshal.agent.send",
        input,
        context,
      ),
    transcript: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalAgentsService["transcript"]>>>(
        provider,
        "marshal.agent.transcript",
        input,
        context,
      ),
    wait: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalAgentsService["wait"]>>>(
        provider,
        "marshal.agent.wait",
        input,
        context,
      ),
    cancel: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalAgentsService["cancel"]>>>(
        provider,
        "marshal.agent.cancel",
        input,
        context,
      ),
    setModel: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalAgentsService["setModel"]>>>(
        provider,
        "marshal.agent.setModel",
        input,
        context,
      ),
  };
}

export function createRuntimeBrainService(port: MarshalRuntimeBrainPort): MarshalBrainService {
  const provider = createRuntimeBrainProvider(port);
  return {
    launch: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalBrainService["launch"]>>>(
        provider,
        "marshal.brain.launch",
        input,
        context,
      ),
    get: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalBrainService["get"]>>>(
        provider,
        "marshal.brain.get",
        input,
        context,
      ),
    send: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalBrainService["send"]>>>(
        provider,
        "marshal.brain.send",
        input,
        context,
      ),
    transcript: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalBrainService["transcript"]>>>(
        provider,
        "marshal.brain.transcript",
        input,
        context,
      ),
    wait: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalBrainService["wait"]>>>(
        provider,
        "marshal.brain.wait",
        input,
        context,
      ),
    cancel: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalBrainService["cancel"]>>>(
        provider,
        "marshal.brain.cancel",
        input,
        context,
      ),
  };
}

export function createRuntimeMemoryService(port: MarshalRuntimeMemoryPort): MarshalMemoryService {
  const provider = createRuntimeMemoryProvider(port);
  return {
    store: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalMemoryService["store"]>>>(
        provider,
        "marshal.memory.store",
        input,
        context,
      ),
    recall: (input, context) =>
      invokeProvider<Awaited<ReturnType<MarshalMemoryService["recall"]>>>(
        provider,
        "marshal.memory.recall",
        input,
        context,
      ),
  };
}

async function invokeProvider<T>(
  provider: CapabilityProvider,
  name: string,
  input: unknown,
  context?: InvocationContext,
): Promise<T> {
  const result = await provider.invoke(
    name,
    input,
    context ?? { principal: { id: "marshal-runtime-host", kind: "agent" } },
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each adapter fixes the capability name and its declared service result type together
  return result.output as T;
}

export function createRuntimeCatalogService(
  port: MarshalRuntimeCatalogPort,
): MarshalCatalogService {
  return {
    listNativeTools: (ownerSessionId) => port.listTools(ownerSessionId),
    onToolsListed: port.onToolsListed,
    onToolInvoked: port.onToolInvoked,
    listTools: (_input, context) =>
      Promise.resolve({
        tools: port.listTools(sessionId(context)).map(
          (tool): MarshalRuntimeToolDescriptor => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.parameters ? { parameters: tool.parameters } : {}),
          }),
        ),
      }),
    listSkills: (_input, context) =>
      Promise.resolve(port.listSkills(sessionId(context), context)).then((skills) => ({
        skills: skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          ...(skill.displayName ? { displayName: skill.displayName } : {}),
          description: skill.description,
          instructions: skill.instructions,
          enabled: skill.enabled,
          createdAt: skill.createdAt,
          scope: skill.scope,
          ...(skill.bundleDirs ? { bundleDirs: skill.bundleDirs } : {}),
        })),
      })),
    getSkill: (input, context) => {
      const currentSessionId = sessionId(context);
      return Promise.resolve(port.listSkills(currentSessionId, context)).then((skills) => {
        const listed = skills.find((candidate) => candidate.name === input.name);
        return Promise.resolve(port.getSkill(currentSessionId, input.name, context)).then(
          (details) => ({
            skill:
              listed && details
                ? {
                    name: listed.name,
                    ...(listed.displayName ? { displayName: listed.displayName } : {}),
                    description: listed.description,
                    instructions: listed.instructions,
                    resourceDir: details.resourceDir,
                    enabled: listed.enabled,
                    createdAt: listed.createdAt,
                    scope: listed.scope,
                    ...(listed.bundleDirs ? { bundleDirs: listed.bundleDirs } : {}),
                  }
                : null,
          }),
        );
      });
    },
    listWorkspaces: (_input, context) =>
      Promise.resolve(port.listWorkspaces(context)).then((workspaces) => ({ workspaces })),
    getSessionContext: async (_input, context) => ({
      session: await port.getSessionContext(
        sessionId(context),
        context?.signal instanceof AbortSignal ? context.signal : undefined,
        context,
      ),
    }),
  };
}
