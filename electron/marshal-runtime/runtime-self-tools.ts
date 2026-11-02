import { RUNTIME_EXTENSION_INTEGRITY_DOMAIN } from "@marshal/runtime/extensions";
import type {
  RuntimeExtensionContractBindingChoice,
  RuntimeExtensionContractRepairRequest,
} from "@marshal/runtime/extensions";

import type { MarshalUiViewport } from "../../common/runtime-ui-viewports";
import type { RuntimeTool } from "../backend/runtime-contract";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "./contracts";
import { compactInvocationResult } from "./runtime-invoke-result";
import type { ShowUiFileAccess } from "./show-ui-files";
import { createShowUiTool, type ShowUiWorkspaceResolver } from "./show-ui-tool";
import { createExecuteModuleTool, createExecuteTypeScriptTool } from "./typescript-execution-tools";

export const RUNTIME_SELF_TOOL_NAMES = Object.freeze([
  "runtimeSearch",
  "runtimeInvoke",
  "runtimeExecuteTypeScript",
  "runtimeListExtensions",
  "runtimeInstallExtension",
  "runtimeUpdateExtension",
  "runtimeEnableExtension",
  "runtimeDisableExtension",
  "runtimeRemoveExtension",
  "runtimeInstallLocalExtension",
  "runtimeConfigureExtension",
  "runtimeSetProvider",
  "runtimeClearProvider",
  "runtimeReadResource",
  "runtimeRepairContractConflict",
  "runtimeExecuteModule",
  "runtimeListRenderTools",
  "runtimeInvokeRenderTool",
  // Mutating/UI: compiles + renders + places a React UI in one call. Kept
  // last so it never shifts the index-based reordering at the bottom of
  // getRuntimeSelfTools(), which is pinned to the first 18 names above.
  "runtimeShowUi",
] as const);

interface RuntimeSelfToolOptions {
  readonly api: MarshalRuntimeApi;
  readonly resolveScope: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<MarshalRuntimeScope | null>;
  // F-DEPLOY-3 (class-completed): every agent-path self-tool that mutates
  // extension/provider state -- enable/disable/remove, install/installLocal/update,
  // configure, setProvider/clearProvider, repairContractConflict -- calls
  // `api.*` directly, bypassing the renderer-initiated `runtime-extensions:enable`
  // IPC handler that normally broadcasts "runtime-extensions:changed" after a
  // successful mutation (see registerRuntimeExtensionsHandlers's notifyChanged).
  // Without this hook, already-open windows never re-query runtime-ui:getPlacements,
  // so an agent-mutated extension's nav contribution only appears after a reload.
  // Read-only self-tools (search/invoke/executeTypeScript/executeModule/
  // listExtensions/readResource/listRenderTools/invokeRenderTool) never call this.
  // runtimeShowUi is mutating (it opens/updates a UI instance) but never touches
  // extension/provider state, so it never calls this hook either.
  readonly notifyExtensionsChanged?: (scope: MarshalRuntimeScope) => void;
  /** Resolves the physical workspace root runtimeShowUi writes generated TSX under. */
  readonly resolveWorkspacePath?: ShowUiWorkspaceResolver;
  /** The client (phone or desktop) a session's latest turn came from. */
  readonly resolveClientViewport?: (sessionId: string) => MarshalUiViewport;
  /** What runtimeShowUi's `file` source may read for a session. */
  readonly resolveFileAccess?: (sessionId: string) => ShowUiFileAccess;
  /** Full-Node TypeScript execution is on; tool descriptions must say so. */
  readonly trustedTypeScript?: boolean;
}

async function requireScope(
  options: RuntimeSelfToolOptions,
  sessionId: string,
  signal?: AbortSignal,
): Promise<MarshalRuntimeScope> {
  const scope = await options.resolveScope(sessionId, signal);
  if (!scope) throw new Error("Marshal Runtime session scope is unavailable.");
  return scope;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Marshal Runtime tool arguments must be an object.");
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeCapabilityInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    // SF-4: the parsed value remains unknown and is accepted only after an object-shape guard.
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function contractRepairRequest(value: unknown): RuntimeExtensionContractRepairRequest {
  const request = record(value);
  const bindings = request.bindings;
  if (
    typeof request.canonicalService !== "string" ||
    !Array.isArray(bindings) ||
    bindings.length === 0 ||
    !bindings.every((binding): binding is RuntimeExtensionContractBindingChoice => {
      const candidate = record(binding);
      return (
        typeof candidate.canonicalService === "string" &&
        typeof candidate.providerIdentity === "string" &&
        typeof candidate.effectiveService === "string" &&
        typeof candidate.publicName === "string"
      );
    })
  ) {
    throw new Error("A complete Runtime contract-conflict repair request is required.");
  }
  const enable = request.enable;
  if (
    enable !== undefined &&
    (!Array.isArray(enable) || !enable.every((identity) => typeof identity === "string"))
  ) {
    throw new Error("Runtime contract-conflict repair enable identities must be strings.");
  }
  return {
    canonicalService: request.canonicalService,
    bindings,
    ...(enable === undefined ? {} : { enable }),
  };
}

function extensionIntegrity(value: unknown) {
  return {
    algorithm: "sha256" as const,
    domain: RUNTIME_EXTENSION_INTEGRITY_DOMAIN,
    value: requiredString(value),
  };
}

export function getRuntimeSelfTools(options: RuntimeSelfToolOptions): readonly RuntimeTool[] {
  const tools: readonly RuntimeTool[] = [
    {
      name: RUNTIME_SELF_TOOL_NAMES[0],
      description:
        "Search the live Marshal Runtime catalog for host tools, skills, resources, session/workspace context, and runtime capabilities. Catalog discovery entries return bounded summaries (large metadata is omitted with an explicit readback route); pass detail: 'full' to receive complete records. To show a local document or file, discover ui.document.open and invoke it with {path: absolutePath, idempotencyKey}. This opens Marshal’s editor in the shared evidence panel; do not compile TSX or generate HTML for file viewing.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", maxLength: 4_000 },
          name: { type: "string", maxLength: 512 },
          detail: { type: "string", enum: ["summary", "full"] },
          tags: { type: "array", maxItems: 20, items: { type: "string", maxLength: 128 } },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          catalogId: { type: "string", maxLength: 512 },
        },
      },
      supportsAbortSignal: true,
      eagerLoad: true,
      handler: async (rawArgs, invocation) => {
        const args = record(rawArgs);
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        return JSON.stringify(
          await options.api.search({
            ...scope,
            query: optionalString(args.query),
            name: optionalString(args.name),
            detail: args.detail === "summary" || args.detail === "full" ? args.detail : undefined,
            tags: Array.isArray(args.tags)
              ? args.tags.filter((tag): tag is string => typeof tag === "string")
              : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
            catalogId: optionalString(args.catalogId),
            signal: invocation.signal,
          }),
        );
      },
    },
    {
      name: RUNTIME_SELF_TOOL_NAMES[1],
      description:
        "Invoke one capability returned by runtimeSearch under the current Marshal session, workspace, and permission policy. Returns compact JSON {ok: true, value: <capability output>} or {ok: false, error: {code, message, approval?}}; pass verbose: true for the full runtime envelope with receipts.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["capability"],
        properties: {
          capability: { type: "string", minLength: 1, maxLength: 512 },
          input: {
            description:
              "Structured input matching the capability's declared input schema. A JSON-encoded OBJECT string is tolerated and parsed for compatibility; prefer the object itself.",
          },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
          verbose: {
            type: "boolean",
            description:
              "Return the full runtime envelope with receipts instead of the compact result.",
          },
        },
      },
      supportsAbortSignal: true,
      eagerLoad: true,
      handler: async (rawArgs, invocation) => {
        const args = record(rawArgs);
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        const result = await options.api.invoke({
          ...scope,
          capability: typeof args.capability === "string" ? args.capability : "",
          input: normalizeCapabilityInput(args.input),
          idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
          signal: invocation.signal,
        });
        return JSON.stringify(args.verbose === true ? result : compactInvocationResult(result));
      },
    },
    createExecuteTypeScriptTool(RUNTIME_SELF_TOOL_NAMES[2], options),
    {
      name: RUNTIME_SELF_TOOL_NAMES[3],
      description: "List live extensions installed in the Marshal Runtime host.",
      parameters: { type: "object", additionalProperties: false },
      supportsAbortSignal: true,
      handler: async (_rawArgs, invocation) => {
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        return JSON.stringify(
          await options.api.listExtensions({ ...scope, signal: invocation.signal }),
        );
      },
    },
    {
      name: RUNTIME_SELF_TOOL_NAMES[4],
      description:
        "Install and immediately activate a verified extension package already materialized under Marshal's trusted extension root.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["packageRoot", "integritySha256"],
        properties: {
          packageRoot: { type: "string", minLength: 1, maxLength: 32_768 },
          integritySha256: {
            type: "string",
            pattern: "^[0-9a-f]{64}$",
          },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
      supportsAbortSignal: true,
      handler: async (rawArgs, invocation) => {
        const args = record(rawArgs);
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        const result = await options.api.installExtension({
          ...scope,
          packageRoot: requiredString(args.packageRoot),
          integrity: extensionIntegrity(args.integritySha256),
          idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
          signal: invocation.signal,
        });
        if (result.ok) options.notifyExtensionsChanged?.(scope);
        return JSON.stringify(result);
      },
    },
    {
      name: RUNTIME_SELF_TOOL_NAMES[5],
      description:
        "Transactionally update an installed live extension from a local package root. Omit integritySha256 for a directory update; the host validates and materializes the package while preserving the old version if staging fails.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["identity", "packageRoot"],
        properties: {
          identity: { type: "string", minLength: 1, maxLength: 214 },
          packageRoot: { type: "string", minLength: 1, maxLength: 32_768 },
          integritySha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
      supportsAbortSignal: true,
      handler: async (rawArgs, invocation) => {
        const args = record(rawArgs);
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        const hasIntegritySha256 = Object.hasOwn(args, "integritySha256");
        const result = await options.api.updateExtension({
          ...scope,
          identity: requiredString(args.identity),
          packageRoot: requiredString(args.packageRoot),
          ...(hasIntegritySha256 ? { integrity: extensionIntegrity(args.integritySha256) } : {}),
          idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
          signal: invocation.signal,
        });
        if (result.ok) options.notifyExtensionsChanged?.(scope);
        return JSON.stringify(result);
      },
    },
    {
      name: RUNTIME_SELF_TOOL_NAMES[9],
      description:
        "Install and immediately activate a new local self-contained Marshal Runtime extension bundle. The host validates, copies, and computes its integrity; ordinary external npm dependencies are not resolved.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["packageRoot"],
        properties: {
          packageRoot: { type: "string", minLength: 1, maxLength: 32_768 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
      supportsAbortSignal: true,
      handler: async (rawArgs, invocation) => {
        const args = record(rawArgs);
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        const result = await options.api.installLocalExtension({
          ...scope,
          packageRoot: requiredString(args.packageRoot),
          idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
          signal: invocation.signal,
        });
        if (result.ok) options.notifyExtensionsChanged?.(scope);
        return JSON.stringify(result);
      },
    },
    {
      name: RUNTIME_SELF_TOOL_NAMES[10],
      description: "Configure an installed Marshal Runtime extension.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["identity", "configuration"],
        properties: {
          identity: { type: "string", minLength: 1, maxLength: 214 },
          configuration: { type: "object" },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
      supportsAbortSignal: true,
      handler: async (rawArgs, invocation) => {
        const args = record(rawArgs);
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        const result = await options.api.configureExtension({
          ...scope,
          identity: requiredString(args.identity),
          configuration: record(args.configuration),
          idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
          signal: invocation.signal,
        });
        if (result.ok) options.notifyExtensionsChanged?.(scope);
        return JSON.stringify(result);
      },
    },
    {
      name: RUNTIME_SELF_TOOL_NAMES[11],
      description: "Choose the provider for an installed Runtime service.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["identity", "serviceId", "providerId"],
        properties: {
          identity: { type: "string", minLength: 1, maxLength: 214 },
          serviceId: { type: "string", minLength: 1, maxLength: 512 },
          providerId: { type: "string", minLength: 1, maxLength: 512 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
      supportsAbortSignal: true,
      handler: async (rawArgs, invocation) => {
        const args = record(rawArgs);
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        const result = await options.api.setProvider({
          ...scope,
          identity: requiredString(args.identity),
          serviceId: requiredString(args.serviceId),
          providerId: requiredString(args.providerId),
          idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
          signal: invocation.signal,
        });
        if (result.ok) options.notifyExtensionsChanged?.(scope);
        return JSON.stringify(result);
      },
    },
    {
      name: RUNTIME_SELF_TOOL_NAMES[12],
      description: "Reset the explicit provider selection for an installed Runtime service.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["identity", "serviceId"],
        properties: {
          identity: { type: "string", minLength: 1, maxLength: 214 },
          serviceId: { type: "string", minLength: 1, maxLength: 512 },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
      supportsAbortSignal: true,
      handler: async (rawArgs, invocation) => {
        const args = record(rawArgs);
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        const result = await options.api.clearProvider({
          ...scope,
          identity: requiredString(args.identity),
          serviceId: requiredString(args.serviceId),
          idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
          signal: invocation.signal,
        });
        if (result.ok) options.notifyExtensionsChanged?.(scope);
        return JSON.stringify(result);
      },
    },
    ...(["enable", "disable", "remove"] as const).map(
      (operation, index): RuntimeTool => ({
        name: RUNTIME_SELF_TOOL_NAMES[6 + index],
        description: `${operation[0]?.toUpperCase()}${operation.slice(1)} an installed Marshal Runtime extension without restarting the runtime host.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["identity"],
          properties: {
            identity: { type: "string", minLength: 1, maxLength: 214 },
            idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
        supportsAbortSignal: true,
        handler: async (rawArgs, invocation) => {
          const args = record(rawArgs);
          const scope = await requireScope(options, invocation.sessionId, invocation.signal);
          const request = {
            ...scope,
            identity: requiredString(args.identity),
            idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
            signal: invocation.signal,
          };
          const result =
            operation === "enable"
              ? await options.api.enableExtension(request)
              : operation === "disable"
                ? await options.api.disableExtension(request)
                : await options.api.removeExtension(request);
          if (result.ok) options.notifyExtensionsChanged?.(scope);
          return JSON.stringify(result);
        },
      }),
    ),
    {
      name: RUNTIME_SELF_TOOL_NAMES[13],
      description:
        "Read a resource URI returned by runtimeSearch, including extension contracts, documentation, and examples.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["uri"],
        properties: {
          uri: { type: "string", minLength: 1, maxLength: 4_096 },
        },
      },
      supportsAbortSignal: true,
      handler: async (rawArgs, invocation) => {
        const args = record(rawArgs);
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        return JSON.stringify(
          await options.api.readResource({
            ...scope,
            uri: requiredString(args.uri),
            signal: invocation.signal,
          }),
        );
      },
    },
    {
      name: RUNTIME_SELF_TOOL_NAMES[14],
      description:
        "Repair a Runtime extension contract conflict using the complete conflict request supplied by Runtime.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["request"],
        properties: {
          request: {
            type: "object",
            additionalProperties: false,
            required: ["canonicalService", "bindings"],
            properties: {
              canonicalService: { type: "string", minLength: 1, maxLength: 512 },
              bindings: { type: "array", minItems: 1, items: { type: "object" } },
              enable: { type: "array", items: { type: "string", maxLength: 214 } },
            },
          },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
      supportsAbortSignal: true,
      handler: async (rawArgs, invocation) => {
        const args = record(rawArgs);
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        const result = await options.api.repairContractConflict({
          ...scope,
          request: contractRepairRequest(args.request),
          idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
          signal: invocation.signal,
        });
        if (result.ok) options.notifyExtensionsChanged?.(scope);
        return JSON.stringify(result);
      },
    },
    createExecuteModuleTool(RUNTIME_SELF_TOOL_NAMES[15], options),
    {
      name: RUNTIME_SELF_TOOL_NAMES[16],
      description: "List the render tools contributed by the live Marshal Runtime UI providers.",
      parameters: { type: "object", additionalProperties: false },
      supportsAbortSignal: true,
      handler: async (_rawArgs, invocation) => {
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        return JSON.stringify(
          await options.api.listRenderTools({ ...scope, signal: invocation.signal }),
        );
      },
    },
    {
      name: RUNTIME_SELF_TOOL_NAMES[17],
      description: "Invoke a render tool returned by runtimeListRenderTools.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "input"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 512 },
          input: { type: "object", additionalProperties: true },
          idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
      supportsAbortSignal: true,
      handler: async (rawArgs, invocation) => {
        const args = record(rawArgs);
        const scope = await requireScope(options, invocation.sessionId, invocation.signal);
        return JSON.stringify(
          await options.api.invokeRenderTool({
            ...scope,
            name: requiredString(args.name),
            input: record(args.input),
            idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
            signal: invocation.signal,
          }),
        );
      },
    },
    createShowUiTool({
      api: options.api,
      resolveScope: options.resolveScope,
      resolveWorkspacePath: options.resolveWorkspacePath,
      resolveClientViewport: options.resolveClientViewport,
      resolveFileAccess: options.resolveFileAccess,
    }),
  ];
  return [
    ...tools.slice(0, 6),
    ...tools.slice(10, 13),
    ...tools.slice(6, 10),
    tools[13],
    tools[14],
    tools[15],
    tools[16],
    tools[17],
    tools[18],
  ];
}

export function bindRuntimeSelfToolsToSession(
  tools: readonly RuntimeTool[],
  sessionId: string,
): readonly RuntimeTool[] {
  return tools.map((tool) => {
    if (!tool.handler) return tool;
    const handler = tool.handler;
    const hint = tool.toolCallHint;
    const subagentStart = tool.subagentStartContext;
    return {
      ...tool,
      handler: (args, invocation) => handler(args, { ...invocation, sessionId }),
      ...(hint ? { toolCallHint: (call) => hint({ ...call, sessionId }) } : {}),
      ...(subagentStart
        ? { subagentStartContext: (call) => subagentStart({ ...call, sessionId }) }
        : {}),
    };
  });
}
