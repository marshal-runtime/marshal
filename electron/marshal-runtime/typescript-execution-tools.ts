/**
 * `runtimeExecuteTypeScript` and `runtimeExecuteModule` host tools. Both
 * return the compact result from typescript-tool-result.ts unless the caller
 * asks for `verbose`; inline source additionally gets the agent-authoring
 * conveniences from typescript-agent-source.ts.
 */
import type { RuntimeModuleSourceReference } from "@marshal/runtime/core";

import type { RuntimeTool } from "../backend/runtime-contract";
import { createCodeSearchGuide } from "./code-search-nudge";
import type { MarshalRuntimeApi, MarshalRuntimeScope } from "./contracts";
import { compactTypeScriptExecutionResult } from "./typescript-tool-result";

export interface TypeScriptExecutionToolOptions {
  readonly api: MarshalRuntimeApi;
  readonly resolveScope: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<MarshalRuntimeScope | null>;
  readonly trustedTypeScript?: boolean;
}

const TRUSTED_TYPESCRIPT_DESCRIPTION =
  "Run TypeScript in a real Node process with full Node access (node:fs, node:child_process, node:https, installed packages). " +
  "Prefer this over Bash for structured work: parsing or reshaping JSON/CSV, walking or batch-editing files, joining output from several commands, " +
  "or anything you would otherwise write as jq, python -c, node -e, awk, or a multi-stage pipe. " +
  "`source` may be a plain script body (top-level await, `return` the result, `input` and `context` in scope) or a module exporting `default async (input, context) => result`. " +
  "`process` and `Buffer` are imported automatically and the working directory is the session workspace; `fetch` is not defined. " +
  "Returns compact JSON {ok, value, stdout?, stderr?}; failures return {ok: false, status, error, diagnostics} with your source line numbers. " +
  "context.runtime.search(query) and context.runtime.invoke(capabilityName, input) compose runtime capabilities; invoke throws on failure. " +
  "Pass verbose: true only when you need the full runtime envelope with receipts.";

const BROKERED_TYPESCRIPT_DESCRIPTION =
  "Execute brokered inline TypeScript through Marshal Runtime with no ambient Node authority. " +
  "`source` may be a plain script body (top-level await, `return` the result, `input` and `context` in scope) or a module exporting `default async (input, context) => result`. " +
  'Example body: return context.runtime.invoke("capability.name", input); ' +
  "Use context.runtime.search(query) or context.runtime.invoke(capabilityName, input), with two positional invoke arguments. Invoke returns the capability output directly and throws on failure. " +
  "Returns compact JSON {ok, value, stdout?, stderr?} or {ok: false, status, error, diagnostics}; pass verbose: true for the full runtime envelope.";

const VERBATIM_INPUT_DESCRIPTION =
  "Passed VERBATIM as the module's first argument — send the structured JSON value itself. A JSON-encoded string arrives as that string, NOT parsed (unlike runtimeInvoke).";

const VERBOSE_PROPERTY = {
  type: "boolean",
  description:
    "Return the full runtime envelope (receipts, provenance, environment) instead of the compact result.",
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Marshal Runtime tool arguments must be an object.");
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function requireScope(
  options: TypeScriptExecutionToolOptions,
  sessionId: string,
  signal?: AbortSignal,
): Promise<MarshalRuntimeScope> {
  const scope = await options.resolveScope(sessionId, signal);
  if (!scope) throw new Error("Marshal Runtime session scope is unavailable.");
  return scope;
}

function moduleReference(value: unknown): RuntimeModuleSourceReference {
  const module = record(value);
  const kind = module.kind;
  const modulePath = typeof module.path === "string" ? module.path : "";
  const exportName = optionalString(module.export);
  if (kind === "workspace_file") {
    return { kind, path: modulePath, ...(exportName ? { export: exportName } : {}) };
  }
  if (kind === "artifact") {
    const scope = module.scope;
    if (
      scope !== undefined &&
      scope !== "workspace" &&
      scope !== "project" &&
      scope !== "session"
    ) {
      throw new Error("Runtime artifact module scope is invalid.");
    }
    return {
      kind,
      path: modulePath,
      ...(scope ? { scope } : {}),
      ...(exportName ? { export: exportName } : {}),
    };
  }
  throw new Error("Runtime module kind must be workspace_file or artifact.");
}

export function createExecuteTypeScriptTool(
  name: string,
  options: TypeScriptExecutionToolOptions,
): RuntimeTool {
  return {
    name,
    description: options.trustedTypeScript
      ? TRUSTED_TYPESCRIPT_DESCRIPTION
      : BROKERED_TYPESCRIPT_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: { type: "string", minLength: 1, maxLength: 2 * 1024 * 1024 },
        input: { description: VERBATIM_INPUT_DESCRIPTION },
        timeoutMs: { type: "integer", minimum: 1, maximum: 60_000 },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        verbose: VERBOSE_PROPERTY,
      },
    },
    supportsAbortSignal: true,
    eagerLoad: true,
    ...(options.trustedTypeScript
      ? { scriptingTool: true, ...createCodeSearchGuide(options) }
      : {}),
    handler: async (rawArgs, invocation) => {
      const args = record(rawArgs);
      const scope = await requireScope(options, invocation.sessionId, invocation.signal);
      const result = await options.api.executeTypeScript({
        ...scope,
        source: typeof args.source === "string" ? args.source : "",
        input: args.input,
        timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
        idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
        agentAuthoring: true,
        signal: invocation.signal,
      });
      return JSON.stringify(
        args.verbose === true ? result : compactTypeScriptExecutionResult(result),
      );
    },
  };
}

export function createExecuteModuleTool(
  name: string,
  options: TypeScriptExecutionToolOptions,
): RuntimeTool {
  return {
    name,
    description: options.trustedTypeScript
      ? "Execute a TypeScript module, referenced by a workspace-relative file or runtime artifact, in a real Node process with full Node access. Returns the same compact result as runtimeExecuteTypeScript."
      : "Execute a brokered TypeScript module referenced by a workspace-relative file or runtime artifact. Returns the same compact result as runtimeExecuteTypeScript.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["module"],
      properties: {
        module: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "path"],
          properties: {
            kind: { type: "string", enum: ["workspace_file", "artifact"] },
            path: { type: "string", minLength: 1, maxLength: 32_768 },
            export: { type: "string", minLength: 1, maxLength: 512 },
            scope: { type: "string", enum: ["workspace", "project", "session"] },
          },
        },
        input: { description: VERBATIM_INPUT_DESCRIPTION },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
        verbose: VERBOSE_PROPERTY,
      },
    },
    supportsAbortSignal: true,
    handler: async (rawArgs, invocation) => {
      const args = record(rawArgs);
      const scope = await requireScope(options, invocation.sessionId, invocation.signal);
      const result = await options.api.executeModule({
        ...scope,
        module: moduleReference(args.module),
        input: args.input,
        idempotencyKey: optionalString(args.idempotencyKey) ?? invocation.toolCallId,
        signal: invocation.signal,
      });
      return JSON.stringify(
        args.verbose === true ? result : compactTypeScriptExecutionResult(result),
      );
    },
  };
}
