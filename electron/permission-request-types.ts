export interface NormalizedBase {
  readonly toolCallId: string | undefined;
}

export interface NormalizedShell extends NormalizedBase {
  readonly kind: "shell";
  /** fullCommandText || command || cmd from raw SDK payload */
  readonly command: string;
  /** Resolved builtin shell server name, or "" for generic shell */
  readonly serverName: string;
  readonly intention: string | undefined;
  readonly warning: string | undefined;
  readonly commandIdentifiers: string[];
}

export interface NormalizedWrite extends NormalizedBase {
  readonly kind: "write";
  readonly path: string;
  readonly diff: string | null;
  readonly intention: string | undefined;
  /**
   * "sdk" = SDK-emitted write paired with a concurrent kind:mcp request.
   * "synthesized-browser" = no paired mcp gate; this IS the only gate.
   */
  readonly origin: "sdk" | "synthesized-browser";
  /** Tool name for display when origin is "synthesized-browser" */
  readonly browserToolName: string | undefined;
}

export interface NormalizedMcp extends NormalizedBase {
  readonly kind: "mcp";
  /** Explicit server name from raw details, or undefined when absent */
  readonly serverName: string | undefined;
  readonly toolName: string;
  readonly toolTitle: string | undefined;
  readonly toolDescription: string | undefined;
  readonly toolArgs: Record<string, unknown>;
  readonly readOnly: boolean;
}

export interface NormalizedRead extends NormalizedBase {
  readonly kind: "read";
  readonly path: string;
}

export interface NormalizedUrl extends NormalizedBase {
  readonly kind: "url";
  readonly url: string;
  readonly toolName: string;
}

export interface NormalizedCustomTool extends NormalizedBase {
  readonly kind: "custom-tool";
  readonly toolName: string;
  readonly toolDescription: string | undefined;
  /** Merged args: nested (args/arguments) preferred over top-level fields */
  readonly toolArgs: Record<string, unknown>;
  readonly intention: string | undefined;
  readonly warning: string | undefined;
  readonly commandIdentifiers: string[];
}

export interface NormalizedMemory extends NormalizedBase {
  readonly kind: "memory";
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
}

export interface NormalizedHook extends NormalizedBase {
  readonly kind: "hook";
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
}

import type { PermissionsEscalationDiff } from "./backend/ports";

export interface NormalizedSettings extends NormalizedBase {
  readonly kind: "settings";
  readonly diff: PermissionsEscalationDiff | undefined;
}

export type NormalizedPermissionRequest =
  | NormalizedShell
  | NormalizedWrite
  | NormalizedMcp
  | NormalizedRead
  | NormalizedUrl
  | NormalizedCustomTool
  | NormalizedMemory
  | NormalizedHook
  | NormalizedSettings;
