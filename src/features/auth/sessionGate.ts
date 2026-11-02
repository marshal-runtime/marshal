import type { AuthStage } from "./deriveStage";

/**
 * Returns `null` when the local telemetry session may start (auth `ready`),
 * otherwise the `AuthStage` to keep showing.
 */
export function sessionGateStage(stage: AuthStage): AuthStage | null {
  return stage.kind === "ready" ? null : stage;
}
