import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createAgentRuntime,
  createRuntimeBuiltinsSource,
  createRuntimeServiceContainer,
} from "@marshal/runtime";
import { computeRuntimeExtensionIntegrity } from "@marshal/runtime/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AGENTIC_BROWSER_EXTENSION_IDENTITY } from "./agentic-browser-runtime-host";
import { ProductionMarshalRuntimeApi } from "./api";
import type { MarshalRuntimeBrowserCommandExecutorPort } from "./browser-command-executor";
import type {
  MarshalRuntimeAuthorityPort,
  MarshalRuntimeCatalogPort,
  MarshalRuntimeModule,
  MarshalRuntimePackageMetadata,
} from "./contracts";
import { MarshalRuntimeHost } from "./host";
import type { MarshalRuntimePackageLoader } from "./runtime-package-loader";
import type { RuntimeUiDeliveryPorts } from "./ui-controller";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BROWSER_ARCHIVE = path.join(
  REPOSITORY_ROOT,
  ".marshal-runtime-packs",
  "archives",
  "agentic-browser-marshal-runtime-extension-0.1.0-marshal-host-1.tgz",
);
const EXTERNAL_EXTENSION_IDENTITY = "@example/external-agentic-browser-extension";
const EXTERNAL_CAPABILITY = "external_browser_navigate";
const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

const BROWSER_PACKAGE_ROOT = (root: string): string =>
  path.join(
    root,
    "app.asar.unpacked",
    "node_modules",
    "@agentic-browser",
    "marshal-runtime-extension",
  );

async function stagePinnedBrowserPackage(root: string): Promise<void> {
  const extractRoot = path.join(root, "archive");
  const packageRoot = BROWSER_PACKAGE_ROOT(root);
  await Promise.all([
    mkdir(extractRoot, { recursive: true }),
    mkdir(path.dirname(packageRoot), { recursive: true }),
  ]);
  await execFileAsync("tar", ["-xf", BROWSER_ARCHIVE, "-C", extractRoot], {
    cwd: REPOSITORY_ROOT,
  });
  await cp(path.join(extractRoot, "package"), packageRoot, { recursive: true });
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("user-managed agentic browser extension integration", () => {
  it("materializes and supports activation, disable, enable, invoke, and remove", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "marshal-external-browser-extension-test-")),
    );
    tempDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const trustedExtensionRoot = path.join(root, "extensions");
    await Promise.all([
      mkdir(workspace),
      mkdir(path.join(root, "protected-results")),
      mkdir(path.join(root, "worktrees")),
      mkdir(trustedExtensionRoot),
      stagePinnedBrowserPackage(root),
    ]);
    await execFileAsync("git", ["init"], { cwd: workspace });
    const authority: MarshalRuntimeAuthorityPort = {
      async resolveScope(scope) {
        return { ...scope, workspacePath: workspace };
      },
      async authorize() {
        return { decision: "allow" };
      },
    };
    const catalog: MarshalRuntimeCatalogPort = {
      listTools: () => [],
      listSkills: () => [],
      getSkill: () => null,
      listWorkspaces: () => [],
      getSessionContext: async () => null,
    };
    const metadata: MarshalRuntimePackageMetadata = {
      name: "@marshal/runtime",
      version: "0.1.0-test",
      entrypoint: "dist/host.js",
      entrySha256: "0".repeat(64),
    };
    const runtimeModule: MarshalRuntimeModule = {
      createAgentRuntime,
      createRuntimeBuiltinsSource,
    };
    const packageLoader: MarshalRuntimePackageLoader = {
      load: async () => runtimeModule,
      metadata: () => metadata,
    };
    const delivery: RuntimeUiDeliveryPorts = {
      notification: vi.fn<RuntimeUiDeliveryPorts["notification"]>(),
      chatMessage: vi.fn<RuntimeUiDeliveryPorts["chatMessage"]>(),
      chatCard: vi.fn<RuntimeUiDeliveryPorts["chatCard"]>(),
    };
    const executeBrowser = vi.fn<MarshalRuntimeBrowserCommandExecutorPort["execute"]>(async () => ({
      success: true,
      data: { content: [{ type: "text", text: "external browser result" }] },
      metadata: { duration: 1, timestamp: Date.now() },
    }));
    const host = new MarshalRuntimeHost({
      location: {
        isPackaged: true,
        appPath: root,
        resourcesPath: root,
      },
      hostWorkspacePath: workspace,
      protectedLifecycleResultRoot: path.join(root, "protected-results"),
      worktreeRoot: path.join(root, "worktrees"),
      trustedExtensionRoot,
      authority,
      catalog,
      serviceContainer: createRuntimeServiceContainer(),
      packageLoader,
      ui: { delivery },
      firstPartyExtensions: [
        {
          identity: AGENTIC_BROWSER_EXTENSION_IDENTITY,
          version: "0.1.0",
          request: {
            packageRoot: BROWSER_PACKAGE_ROOT(root),
            integrity: computeRuntimeExtensionIntegrity(BROWSER_PACKAGE_ROOT(root)),
          },
        },
      ],
      agenticBrowser: {
        executor: {
          execute: executeBrowser,
          dispose: vi.fn<MarshalRuntimeBrowserCommandExecutorPort["dispose"]>(
            async () => undefined,
          ),
        },
      },
    });
    const api = new ProductionMarshalRuntimeApi(host);

    try {
      await host.start();
      const sourceRoot = path.join(root, "external-browser-source");
      await mkdir(path.join(sourceRoot, "dist"), { recursive: true });
      await Promise.all([
        writeFile(
          path.join(sourceRoot, "package.json"),
          `${JSON.stringify(
            {
              name: EXTERNAL_EXTENSION_IDENTITY,
              version: "1.0.0",
              type: "commonjs",
              main: "dist/runtime.cjs",
            },
            null,
            2,
          )}\n`,
        ),
        writeFile(
          path.join(sourceRoot, "runtime-extension.json"),
          `${JSON.stringify(
            {
              schemaVersion: 1,
              identity: EXTERNAL_EXTENSION_IDENTITY,
              version: "1.0.0",
              entrypoint: "dist/runtime.cjs",
              moduleFormat: "commonjs-bundle-v1",
            },
            null,
            2,
          )}\n`,
        ),
        writeFile(
          path.join(sourceRoot, "dist", "runtime.cjs"),
          [
            'const browserHost = require("@agentic-browser/runtime-host");',
            "const descriptor = {",
            '  protocolVersion: "1.0.0",',
            `  name: ${JSON.stringify(EXTERNAL_CAPABILITY)},`,
            '  version: "1.0.0",',
            '  description: "Invoke browser navigation through a user-managed extension.",',
            '  inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },',
            '  outputSchema: { type: "object", properties: { invoked: { type: "boolean" } }, required: ["invoked"], additionalProperties: false },',
            '  permissions: [{ permission: "marshal.browser.invoke:browser_navigate", risk: "low" }],',
            "};",
            "module.exports = {",
            "  activate() {",
            "    return {",
            "      capabilityProviders: [{",
            '        id: "external-agentic-browser",',
            '        version: "1.0.0",',
            "        list: () => [descriptor],",
            "        get: (name) => name === descriptor.name ? descriptor : undefined,",
            "        invoke: async (_name, input, context) => {",
            "          const session = browserHost.resolveBrowserSession(context);",
            '          await browserHost.invokeBrowserCommand("browser_navigate", input, session.context);',
            "          return { output: { invoked: true } };",
            "        },",
            "      }],",
            "    };",
            "  },",
            "};",
            "",
          ].join("\n"),
        ),
      ]);

      await expect(
        api.installLocalExtension({
          sessionId: "session-1",
          workspaceName: "workspace",
          packageRoot: sourceRoot,
          idempotencyKey: "external-browser-install",
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          identity: EXTERNAL_EXTENSION_IDENTITY,
          version: "1.0.0",
          status: "enabled",
        },
      });
      await rm(sourceRoot, { recursive: true, force: true });
      await expect(
        api.search({
          sessionId: "session-1",
          workspaceName: "workspace",
          name: EXTERNAL_CAPABILITY,
          detail: "full",
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: { matches: [{ capability: { name: EXTERNAL_CAPABILITY } }] },
      });
      await expect(
        api.invoke({
          sessionId: "session-1",
          workspaceName: "workspace",
          capability: EXTERNAL_CAPABILITY,
          input: { url: "https://example.com/external" },
          idempotencyKey: "external-browser-first-invoke",
        }),
      ).resolves.toMatchObject({ ok: true, value: { output: { invoked: true } } });
      expect(executeBrowser).toHaveBeenCalledTimes(1);

      await expect(
        api.disableExtension({
          sessionId: "session-1",
          workspaceName: "workspace",
          identity: EXTERNAL_EXTENSION_IDENTITY,
          idempotencyKey: "external-browser-disable",
        }),
      ).resolves.toMatchObject({ ok: true, value: { status: "disabled" } });
      await expect(
        api.search({
          sessionId: "session-1",
          workspaceName: "workspace",
          name: EXTERNAL_CAPABILITY,
          detail: "full",
        }),
      ).resolves.toMatchObject({ ok: true, value: { matches: [] } });

      await expect(
        api.enableExtension({
          sessionId: "session-1",
          workspaceName: "workspace",
          identity: EXTERNAL_EXTENSION_IDENTITY,
          idempotencyKey: "external-browser-enable",
        }),
      ).resolves.toMatchObject({ ok: true, value: { status: "enabled" } });
      await expect(
        api.invoke({
          sessionId: "session-1",
          workspaceName: "workspace",
          capability: EXTERNAL_CAPABILITY,
          input: { url: "https://example.com/re-enabled" },
          idempotencyKey: "external-browser-second-invoke",
        }),
      ).resolves.toMatchObject({ ok: true, value: { output: { invoked: true } } });
      expect(executeBrowser).toHaveBeenCalledTimes(2);

      await expect(
        api.removeExtension({
          sessionId: "session-1",
          workspaceName: "workspace",
          identity: EXTERNAL_EXTENSION_IDENTITY,
          idempotencyKey: "external-browser-remove",
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: { identity: EXTERNAL_EXTENSION_IDENTITY, removed: true },
      });
      await expect(
        api.search({
          sessionId: "session-1",
          workspaceName: "workspace",
          name: EXTERNAL_CAPABILITY,
          detail: "full",
        }),
      ).resolves.toMatchObject({ ok: true, value: { matches: [] } });
      const extensions = await api.listExtensions({
        sessionId: "session-1",
        workspaceName: "workspace",
      });
      if (!extensions.ok) {
        throw new Error(`${extensions.error.code}: ${extensions.error.message}`);
      }
      expect(extensions.value.map(({ identity }) => identity)).not.toContain(
        EXTERNAL_EXTENSION_IDENTITY,
      );
    } finally {
      api.dispose();
      await host.dispose();
    }
  });
});
