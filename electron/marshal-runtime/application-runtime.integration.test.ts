import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAgentRuntime,
  createRuntimeBuiltinsSource,
  createRuntimeServiceContainer,
  RUNTIME_PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilityProvider,
} from "@marshal/runtime";
import { expect, it, vi } from "vitest";

import { testDouble } from "../testing/harness";
import { RuntimeApplicationAuthority } from "./application-authority";
import { createApplicationJobProvider } from "./application-job-provider";
import type { RuntimeApplicationJobs } from "./application-jobs";
import { MarshalRuntimeHost } from "./host";
import { createRuntimeUiImageProvider } from "./runtime-ui-image-provider";
import type { SelectedSessionDeliveryService } from "./selected-session-delivery";
import { createSelectedSessionDeliveryProvider } from "./selected-session-provider";

it("executes an application through the real kernel without a chat and denies forged agent authority", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "marshal-app-runtime-")));
  const workspace = path.join(root, "workspace");
  await Promise.all(
    [
      workspace,
      path.join(root, "extensions"),
      path.join(root, "worktrees"),
      path.join(root, "protected-results"),
    ].map((directory) => mkdir(directory)),
  );
  const applicationAuthority = new RuntimeApplicationAuthority();
  const descriptor: CapabilityDescriptor = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    name: "example.review.list",
    version: "1.0.0",
    description: "Read review state",
    tags: [],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { application: { type: "string" }, session: { type: ["string", "null"] } },
      additionalProperties: false,
    },
    permissions: [{ permission: "example.review.read", risk: "low" }],
  };
  const provider: CapabilityProvider = {
    id: "example",
    version: "1.0.0",
    list: () => [descriptor],
    get: (name) => (name === descriptor.name ? descriptor : undefined),
    invoke: (_name, _input, context) => ({
      output: {
        application: applicationAuthority.resolve(context)?.owner.applicationId,
        session: context.scope?.sessionId ?? null,
      },
    }),
  };
  const resolveScope = vi.fn<() => Promise<null>>(async () => null);
  const host = new MarshalRuntimeHost({
    applicationAuthority,
    location: { isPackaged: false, appPath: root, resourcesPath: root },
    hostWorkspacePath: workspace,
    protectedLifecycleResultRoot: path.join(root, "protected-results"),
    worktreeRoot: path.join(root, "worktrees"),
    trustedExtensionRoot: path.join(root, "extensions"),
    authority: {
      resolveScope,
      authorize: async () => ({ decision: "deny", reason: "No session authority" }),
    },
    catalog: {
      listTools: () => [],
      listSkills: () => [],
      getSkill: () => null,
      listWorkspaces: () => [],
      getSessionContext: async () => null,
    },
    serviceContainer: createRuntimeServiceContainer(),
    packageLoader: {
      load: async () => ({ createAgentRuntime, createRuntimeBuiltinsSource }),
      metadata: () => ({
        name: "@marshal/runtime",
        version: "test",
        entrypoint: "test",
        entrySha256: "0".repeat(64),
      }),
    },
    additionalProviderSources: [
      () => provider,
      () =>
        createApplicationJobProvider(testDouble<RuntimeApplicationJobs>({}), () => {
          throw new Error("Not an app call");
        }),
      () =>
        createRuntimeUiImageProvider(async () => {
          throw new Error("No image import in startup test");
        }, applicationAuthority),
      () => createSelectedSessionDeliveryProvider(testDouble<SelectedSessionDeliveryService>({})),
    ],
  });
  const request = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    targetType: "operation" as const,
    target: descriptor.name,
    input: {},
  };
  try {
    const result = await applicationAuthority.run(
      {
        owner: {
          extensionId: "example",
          applicationId: "review",
          applicationScope: "user",
          workspaceName: "marshal",
        },
        capabilities: new Set([descriptor.name]),
        workspacePath: workspace,
        isActive: async () => true,
      },
      async (context) => {
        const successful = await host.executeApplication(request, context);
        await expect(host.execute(request, context)).rejects.toMatchObject({
          code: "invalid_scope",
        });
        return successful;
      },
    );
    expect(result.status).toBe("success");
    expect(result.result?.output).toEqual({
      application: "review",
      session: expect.stringMatching(/^runtime-/),
    });
    // The portable runtime creates an internal trace scope; no Marshal chat is resolved or created.
    expect(resolveScope).not.toHaveBeenCalled();
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
