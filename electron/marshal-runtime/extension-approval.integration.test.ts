/**
 * An installed runtime extension tool that declares a permission needs the user's approval on the
 * real agent invoke path: real host, real production authority, real approval broker, and a
 * policy that prompts. A capability with no declared permission runs without a prompt.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAgentRuntime,
  createRuntimeServiceContainer,
  RUNTIME_PROTOCOL_VERSION,
} from "@marshal/runtime";
import { computeRuntimeExtensionIntegrity } from "@marshal/runtime/extensions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalBroker } from "../approval-broker";
import type { PermissionPolicy } from "../permission-policy";
import type { PersistedSession } from "../session-store";
import type { SessionManager } from "../sessions";
import { testDouble } from "../testing/harness";
import { ProductionMarshalRuntimeApi } from "./api";
import type { MarshalRuntimeModule, MarshalRuntimePackageMetadata } from "./contracts";
import { MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX } from "./contracts";
import { MarshalRuntimeHost } from "./host";
import {
  createExtensionDeclaredPermissionResolver,
  createProductionMarshalRuntimePorts,
  type ExtensionDeclaredPermissionResolver,
} from "./production-adapter";
import type { MarshalRuntimePackageLoader } from "./runtime-package-loader";
import type { RuntimeUiDeliveryPorts } from "./ui-controller";

const SESSION_ID = "session-approval-1";
const WORKSPACE_NAME = "workspace";
const WRITE_CAPABILITY = "fixture.notes.write";
const READ_CAPABILITY = "fixture.notes.read";
const WRITE_REASON = "Saves a note to the shared notebook.";
const WRITE_RISK = "high";
const EXPECTED_WARNING = `High risk: ${WRITE_REASON}`;
const PERMISSION_FORMS = [
  { form: "extension-chosen permission id", permission: "fixture.notes.write-access" },
  {
    form: "marshal.tool.invoke permission id",
    permission: `${MARSHAL_RUNTIME_TOOL_PERMISSION_PREFIX}${WRITE_CAPABILITY}`,
  },
] as const;

const packageMetadata: MarshalRuntimePackageMetadata = {
  name: "@marshal/runtime",
  version: "0.1.0-test",
  entrypoint: "dist/host.js",
  entrySha256: "0".repeat(64),
};

function extensionSource(writePermission: string): string {
  return `
    let writes = 0;
    const base = {
      protocolVersion: ${JSON.stringify(RUNTIME_PROTOCOL_VERSION)},
      version: "1.0.0",
      inputSchema: { type: "object", additionalProperties: true },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["writes"],
        properties: { writes: { type: "number" } }
      }
    };
    const write = Object.freeze({
      ...base,
      name: ${JSON.stringify(WRITE_CAPABILITY)},
      title: "Write a note",
      description: "Writes a note.",
      permissions: [{
        permission: ${JSON.stringify(writePermission)},
        reason: ${JSON.stringify(WRITE_REASON)},
        risk: ${JSON.stringify(WRITE_RISK)}
      }]
    });
    const read = Object.freeze({
      ...base,
      name: ${JSON.stringify(READ_CAPABILITY)},
      title: "Count notes",
      description: "Counts the notes written so far."
    });
    module.exports = {
      async activate() {
        return {
          capabilityProviders: [{
            id: "fixture.notes",
            version: "1.0.0",
            list() { return [write, read]; },
            get(name) { return [write, read].find((descriptor) => descriptor.name === name); },
            invoke(name) {
              if (name === write.name) writes += 1;
              else if (name !== read.name) throw Object.assign(new Error("not found"), { code: "not_found" });
              return { output: { writes } };
            }
          }],
          dispose() {}
        };
      }
    };
  `;
}

describe.each(PERMISSION_FORMS)(
  "runtime extension approval on the agent invoke path: $form",
  ({ permission }) => {
    let root: string;
    let host: MarshalRuntimeHost;
    let api: ProductionMarshalRuntimeApi;
    let broker: ApprovalBroker;
    let evaluateDetailed: ReturnType<typeof vi.fn<PermissionPolicy["evaluateDetailed"]>>;

    beforeEach(async () => {
      root = await mkdtemp(path.join(await realpath(tmpdir()), "marshal-extension-approval-"));
      const trustedExtensionRoot = path.join(root, "extensions");
      await Promise.all(
        ["workspace", "scope", "protected-results", "worktrees", "extensions"].map((directory) =>
          mkdir(path.join(root, directory), { recursive: true }),
        ),
      );
      broker = new ApprovalBroker();
      evaluateDetailed = vi
        .fn<PermissionPolicy["evaluateDetailed"]>()
        .mockReturnValue(testDouble({ decision: "prompt" }));
      const policy = testDouble<PermissionPolicy>({
        evaluateDetailed,
        evaluateHardDenial: vi
          .fn<PermissionPolicy["evaluateHardDenial"]>()
          .mockReturnValue(testDouble({ decision: "prompt" })),
        recordInteractiveOutcome: vi
          .fn<PermissionPolicy["recordInteractiveOutcome"]>()
          .mockReturnValue(true),
        logInfraFailure: vi.fn<PermissionPolicy["logInfraFailure"]>(),
      });
      const sessionManager = testDouble<SessionManager>({
        getSessionScopeAsync: async () =>
          testDouble<PersistedSession>({
            id: SESSION_ID,
            name: "Extension approval session",
            workspaceName: WORKSPACE_NAME,
            messages: [],
          }),
        listWorkspacesForSelfTools: () => [
          { name: WORKSPACE_NAME, path: path.join(root, "scope") },
        ],
      });
      let resolveDeclared: ExtensionDeclaredPermissionResolver = () => false;
      const ports = createProductionMarshalRuntimePorts({
        sessionManager,
        permissionPolicy: policy,
        approvalBroker: broker,
        workspaceDir: path.join(root, "default-workspace"),
        resolveExtensionDeclaredPermission: (...args) => resolveDeclared(...args),
      });
      const runtimeModule: MarshalRuntimeModule = {
        createAgentRuntime,
        createRuntimeBuiltinsSource: () => () => ({ providers: [], dispose: async () => {} }),
      };
      const packageLoader: MarshalRuntimePackageLoader = {
        load: async () => runtimeModule,
        metadata: () => packageMetadata,
      };
      const delivery: RuntimeUiDeliveryPorts = {
        notification: async () => undefined,
        chatMessage: async () => undefined,
        chatCard: async () => undefined,
      };
      host = new MarshalRuntimeHost({
        location: { isPackaged: false, appPath: root, resourcesPath: root },
        hostWorkspacePath: path.join(root, "workspace"),
        protectedLifecycleResultRoot: path.join(root, "protected-results"),
        worktreeRoot: path.join(root, "worktrees"),
        trustedExtensionRoot,
        authority: ports.authority,
        approval: ports.approval,
        catalog: {
          listTools: () => [],
          listSkills: () => [],
          getSkill: () => null,
          listWorkspaces: () => [],
          getSessionContext: async () => null,
        },
        serviceContainer: createRuntimeServiceContainer(),
        packageLoader,
        ui: { delivery },
      });
      api = new ProductionMarshalRuntimeApi(host);
      await host.start();
      resolveDeclared = createExtensionDeclaredPermissionResolver(host);

      const packageRoot = path.join(trustedExtensionRoot, "notes-v1");
      await mkdir(packageRoot, { recursive: true });
      await Promise.all([
        writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({
            name: "@fixture/notes-extension",
            version: "1.0.0",
            type: "commonjs",
            main: "index.cjs",
          }),
        ),
        writeFile(
          path.join(packageRoot, "runtime-extension.json"),
          JSON.stringify({
            schemaVersion: 1,
            identity: "@fixture/notes-extension",
            version: "1.0.0",
            entrypoint: "index.cjs",
            moduleFormat: "commonjs-bundle-v1",
          }),
        ),
        writeFile(path.join(packageRoot, "index.cjs"), extensionSource(permission)),
      ]);
      const installed = await api.installExtension({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        packageRoot,
        integrity: computeRuntimeExtensionIntegrity(packageRoot),
        idempotencyKey: "install-notes-extension",
      });
      if (!installed.ok) throw new Error(`${installed.error.code}: ${installed.error.message}`);
    });

    afterEach(async () => {
      broker.drainAll();
      api.dispose();
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    });

    const invoke = (capability: string, idempotencyKey: string) =>
      api.invoke({
        sessionId: SESSION_ID,
        workspaceName: WORKSPACE_NAME,
        capability,
        input: {},
        idempotencyKey,
      });

    const requestApproval = async (idempotencyKey: string): Promise<string> => {
      const prompted = await invoke(WRITE_CAPABILITY, idempotencyKey);
      if (prompted.ok || prompted.error.code !== "approval-required") {
        throw new Error(`Expected approval-required, got ${JSON.stringify(prompted)}.`);
      }
      const approvalId = prompted.error.approval?.approvalId;
      if (typeof approvalId !== "string") throw new Error("approval-required has no approval ID.");
      return approvalId;
    };

    describe("sanity", () => {
      it("asks first and runs the tool once after the user allows it", async () => {
        const approvalId = await requestApproval("write-allow");

        expect(broker.hasPending(approvalId)).toBe(true);
        expect(broker.getPendingRequest(approvalId)).toMatchObject({
          kind: "custom-tool",
          toolName: WRITE_CAPABILITY,
          warning: EXPECTED_WARNING,
        });
        await expect(invoke(READ_CAPABILITY, "count-before")).resolves.toMatchObject({
          ok: true,
          value: { output: { writes: 0 } },
        });

        expect(broker.resolve(approvalId, "allow")).toBe(true);
        await expect(invoke(WRITE_CAPABILITY, "write-allow")).resolves.toMatchObject({
          ok: true,
          value: { output: { writes: 1 } },
        });
      });

      it("runs a capability that declares no permission without asking", async () => {
        await expect(invoke(READ_CAPABILITY, "read-only")).resolves.toMatchObject({ ok: true });
        expect(evaluateDetailed).not.toHaveBeenCalled();
      });
    });

    describe("error handling", () => {
      it("never runs the tool when the user denies it", async () => {
        const approvalId = await requestApproval("write-deny");

        expect(broker.resolve(approvalId, "deny")).toBe(true);
        await expect(invoke(WRITE_CAPABILITY, "write-deny")).resolves.toMatchObject({
          ok: false,
          error: { code: "permission-denied" },
        });
        await expect(invoke(READ_CAPABILITY, "count-after-deny")).resolves.toMatchObject({
          ok: true,
          value: { output: { writes: 0 } },
        });
      });
    });

    describe("edge cases", () => {
      it("keeps the tool unrun while the card is still pending", async () => {
        const approvalId = await requestApproval("write-pending");

        await expect(invoke(WRITE_CAPABILITY, "write-pending")).resolves.toMatchObject({
          ok: false,
          error: { code: "approval-required", approval: { approvalId } },
        });
        await expect(invoke(READ_CAPABILITY, "count-pending")).resolves.toMatchObject({
          value: { output: { writes: 0 } },
        });
      });
    });
  },
);
