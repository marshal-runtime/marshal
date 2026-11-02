import type { CommandCenterSafeBackendEvent } from "../../common/command-center-contract";
import type { BackendOrigin, SessionSource } from "../../common/marshal-ipc-contract";

export interface CommandCenterSessionLifecycleInput {
  sessionId: string;
  lifecycle:
    | "created"
    | "restored"
    | "selected"
    | "busy"
    | "idle"
    | "errored"
    | "deleted"
    | "renamed";
  source?: SessionSource | "unknown";
  backendOrigin?: BackendOrigin;
}

export interface CommandCenterSessionObserver {
  onSessionLifecycle(input: CommandCenterSessionLifecycleInput): void;
  onSafeBackendEvent(event: CommandCenterSafeBackendEvent): void;
  onToolActivity(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    serverName?: string;
    args?: unknown;
  }): void;
  onToolResult(input: { sessionId: string; toolCallId: string; result: unknown }): void;
}
