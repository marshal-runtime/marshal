import { RUNTIME_PROTOCOL_VERSION } from "@marshal/runtime";
import type { RuntimeCallContext } from "@marshal/runtime";

import type { ContextPersonEntity } from "../../../common/marshal-ipc-contract";

interface RuntimePeopleHost {
  search(
    request: {
      readonly protocolVersion: string;
      readonly tags: readonly string[];
      readonly detail: "summary";
      readonly limit: number;
    },
    context: RuntimeCallContext,
  ): Promise<{
    readonly matches: readonly { readonly capability: { readonly name: string } }[];
  }>;
  execute(
    request: {
      readonly protocolVersion: string;
      readonly targetType: "operation";
      readonly target: string;
      readonly input: unknown;
    },
    context: RuntimeCallContext,
  ): Promise<{
    readonly status: string;
    readonly result?: { readonly output: unknown };
    readonly error?: { readonly message?: string };
  }>;
}

export interface RuntimePeopleScope {
  readonly sessionId: string;
  readonly workspaceName: string;
  readonly workspacePath: string;
}

export function createRuntimePeopleSearch(options: {
  readonly host: RuntimePeopleHost;
  readonly resolveScope: () => Promise<RuntimePeopleScope | null>;
}): (query: string) => Promise<readonly ContextPersonEntity[] | undefined> {
  return async (query) => {
    const scope = await options.resolveScope();
    if (!scope) return undefined;
    const context: RuntimeCallContext = {
      sessionId: scope.sessionId,
      workspacePath: scope.workspacePath,
      metadata: { marshalWorkspaceName: scope.workspaceName },
    };
    const search = await options.host.search(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        tags: ["directory", "people", "context-picker"],
        detail: "summary",
        limit: 2,
      },
      context,
    );
    if (search.matches.length === 0) return undefined;
    if (search.matches.length > 1) {
      throw new Error("More than one Runtime people provider is active; select one provider.");
    }

    const target = search.matches[0]?.capability.name;
    if (!target) return undefined;
    const response = await options.host.execute(
      {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        targetType: "operation",
        target,
        input: { query, limit: 25 },
      },
      context,
    );
    if (response.status !== "success" || !response.result) {
      throw new Error(
        response.error?.message ?? `Runtime people search ended with ${response.status}.`,
      );
    }
    return normalizePeople(response.result.output);
  };
}

function normalizePeople(output: unknown): readonly ContextPersonEntity[] {
  const container = isRecord(output) ? output : {};
  const candidates = Array.isArray(container.people)
    ? container.people
    : Array.isArray(output)
      ? output
      : [];
  return candidates.flatMap((candidate): ContextPersonEntity[] => {
    if (!isRecord(candidate)) return [];
    const id = stringValue(candidate.id);
    const displayName = stringValue(candidate.displayName) || stringValue(candidate.name);
    if (!id || !displayName) return [];
    return [
      {
        type: "People",
        id,
        referenceId: stringValue(candidate.referenceId) || id,
        displayName,
        ...optionalString(candidate.email, "email"),
        ...optionalString(candidate.jobTitle ?? candidate.title, "jobTitle"),
        ...optionalString(candidate.department, "department"),
      },
    ];
  });
}

function optionalString(value: unknown, key: "email" | "jobTitle" | "department") {
  const normalized = stringValue(value);
  return normalized ? { [key]: normalized } : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
