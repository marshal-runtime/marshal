import {
  createRuntimeServiceContainer,
  createAllowAllPermissionBroker,
  RuntimeKernel,
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeHostFactoryContext,
  type CapabilityProvider,
  type InvocationContext,
} from "@marshal/runtime";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeTool } from "../backend/runtime-contract";
import { testDouble } from "../testing/harness";
import type { MarshalRuntimeCatalogPort } from "./contracts";
import { createMarshalHostProviderSource, createRuntimeCatalogService } from "./providers";
import { MarshalServiceSymbols } from "./service-symbols";

const invocationContext: InvocationContext = {
  principal: { id: "test", kind: "agent" },
  identity: { harnessId: "test" },
  scope: { sessionId: "session-1" },
  metadata: { marshalWorkspaceName: "marshal" },
};

function tool(name: string): RuntimeTool {
  return {
    name,
    description: `${name} description`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
    },
    handler: vi.fn<RuntimeTool["handler"]>(async () => `${name} output`),
  };
}

function catalog(listTools: MarshalRuntimeCatalogPort["listTools"]): MarshalRuntimeCatalogPort {
  return {
    listTools,
    listSkills: () => [],
    getSkill: () => null,
    listWorkspaces: () => [],
    getSessionContext: async () => null,
  };
}

async function toolProvider(port: MarshalRuntimeCatalogPort) {
  const services = createRuntimeServiceContainer();
  await services.bind(MarshalServiceSymbols.catalog, {
    useValue: createRuntimeCatalogService(port),
  });
  const source: unknown = Reflect.apply(createMarshalHostProviderSource(services), undefined, [
    undefined,
  ]);
  if (
    source === null ||
    typeof source !== "object" ||
    !("providers" in source) ||
    !Array.isArray(source.providers)
  ) {
    throw new Error("Marshal provider source did not return a provider bundle.");
  }
  const provider = source.providers.find(
    (candidate): candidate is CapabilityProvider =>
      isCapabilityProvider(candidate) && candidate.id === "marshal.host-tools",
  );
  if (!provider) throw new Error("Marshal host-tool provider was not created.");
  return { provider, services };
}

function isCapabilityProvider(value: unknown): value is CapabilityProvider {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string" &&
    "list" in value &&
    typeof value.list === "function" &&
    "invoke" in value &&
    typeof value.invoke === "function"
  );
}

describe("Marshal host-tool provider", () => {
  it("lists no dynamic tools without a session scope", async () => {
    const { provider } = await toolProvider(catalog(() => [tool("one")]));
    const withoutSession = { ...invocationContext, scope: undefined };

    await expect(Promise.resolve(provider.list(withoutSession))).resolves.toEqual([]);
  });

  it("rejects duplicate ordinary tool names instead of shadowing", async () => {
    const { provider } = await toolProvider(catalog(() => [tool("duplicate"), tool("duplicate")]));

    expect(() => provider.list(invocationContext)).toThrow(
      'Duplicate Marshal host tool "duplicate".',
    );
  });

  it("invokes and reports the original RuntimeTool object", async () => {
    const original = tool("original");
    const onToolsListed = vi.fn<NonNullable<MarshalRuntimeCatalogPort["onToolsListed"]>>();
    const onToolInvoked = vi.fn<NonNullable<MarshalRuntimeCatalogPort["onToolInvoked"]>>();
    const { provider } = await toolProvider({
      ...catalog(() => [original]),
      onToolsListed,
      onToolInvoked,
    });

    const result = await provider.invoke(
      "marshal.tool.original",
      { value: "input" },
      invocationContext,
    );

    expect(onToolsListed).toHaveBeenCalledWith([original]);
    expect(onToolInvoked).toHaveBeenCalledWith(original);
    expect(original.handler).toHaveBeenCalledOnce();
    expect(result).toEqual({ output: { content: "original output" } });
  });

  it("uses the replacement catalog service on the next operation", async () => {
    const first = tool("first");
    const second = tool("second");
    const { provider, services } = await toolProvider(catalog(() => [first]));

    await expect(Promise.resolve(provider.list(invocationContext))).resolves.toMatchObject([
      { name: "marshal.tool.first" },
    ]);
    await services.replace(MarshalServiceSymbols.catalog, {
      useValue: createRuntimeCatalogService(catalog(() => [second])),
    });
    await expect(Promise.resolve(provider.list(invocationContext))).resolves.toMatchObject([
      { name: "marshal.tool.second" },
    ]);
  });
});

it("deduplicates name-based skill identities consistently for catalog search and resources", async () => {
  const firstSkill = {
    id: "local-e2b",
    name: "e2b-runs",
    displayName: "Workspace E2B runs",
    description: "Run E2B tasks",
    instructions: "Workspace instructions",
    enabled: true,
    createdAt: "now",
    scope: "local" as const,
  };
  const port: MarshalRuntimeCatalogPort = {
    ...catalog(() => [tool("finish")]),
    listSkills: () => [
      firstSkill,
      { ...firstSkill, id: "global-e2b", scope: "global", displayName: "Global E2B runs" },
    ],
    getSkill: () => ({ instructions: firstSkill.instructions, resourceDir: null }),
  };
  const services = createRuntimeServiceContainer();
  await services.bind(MarshalServiceSymbols.catalog, {
    useValue: createRuntimeCatalogService(port),
  });
  const source = await createMarshalHostProviderSource(services)(
    testDouble<RuntimeHostFactoryContext>({}),
  );
  if (!("catalog" in source) || !source.catalog || !source.resources)
    throw new Error("Skill catalog source missing");
  const entries = await source.catalog.list(invocationContext);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    id: "catalog://marshal.skill-catalog/e2b-runs",
    title: "Workspace E2B runs",
    metadata: { scope: "local" },
  });
  expect(await source.catalog.get?.(entries[0].id, invocationContext)).toEqual(entries[0]);
  const resources = await source.resources.listResources(invocationContext);
  expect(resources).toHaveLength(1);
  expect(await source.resources.readResource(resources[0].uri, invocationContext)).toMatchObject({
    text: "Workspace instructions",
  });
  const kernel = new RuntimeKernel({
    catalogProviders: [source.catalog],
  });
  expect(
    await kernel.runtimeSearch(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, query: "e2b" },
      invocationContext,
    ),
  ).toMatchObject({ discoveries: [{ entry: { title: "Workspace E2B runs" } }] });

  // Exact capability lookup/execution must stay available even if an unrelated
  // catalog provider is malformed; this also verifies the live-run workaround.
  const brokenCatalogKernel = new RuntimeKernel({
    permissionBroker: createAllowAllPermissionBroker(),
    catalogProviders: [{ ...source.catalog, list: () => [entries[0], entries[0]] }],
  });
  for (const provider of source.providers) brokenCatalogKernel.register(provider);
  await expect(
    brokenCatalogKernel.runtimeSearch(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, query: "finish" },
      invocationContext,
    ),
  ).rejects.toThrow("declared by multiple providers");
  expect(
    await brokenCatalogKernel.runtimeSearch(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, name: "marshal.tool.finish" },
      invocationContext,
    ),
  ).toMatchObject({ matches: [{ capability: { name: "marshal.tool.finish" } }] });
  expect(
    await brokenCatalogKernel.runtimeExec(
      { protocolVersion: RUNTIME_PROTOCOL_VERSION, target: "marshal.tool.finish", input: {} },
      invocationContext,
    ),
  ).toMatchObject({ status: "success", result: { output: { content: "finish output" } } });
});
