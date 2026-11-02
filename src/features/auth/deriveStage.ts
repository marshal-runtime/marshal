/**
 * Pure stage-selection function for the GitHub auth flow.
 *
 * Separated from useAuthFlow so stage permutations can be unit-tested as
 * data-in / data-out, without mounting hooks or mocking IPC.
 */

import type { GitHubAuthStatus } from "./useGitHubDeviceAuth";

export type AuthStage =
  | { kind: "checking" }
  | { kind: "start"; error?: string }
  | { kind: "github-device-code"; code: string; expired: boolean }
  | { kind: "copilot-access-error"; login?: string }
  | { kind: "ready" };

export interface AuthInputs {
  gh: {
    status: GitHubAuthStatus;
    login?: string;
    copilotPlan?: string;
    deviceCode?: string;
    deviceCodeExpired?: boolean;
    errorMessage?: string;
  };
}

export function deriveStage({ gh }: AuthInputs): AuthStage {
  if (gh.status === "checking") return { kind: "checking" };
  if (gh.status === "copilot-access-error" || gh.status === "not-allowed-plan") {
    return { kind: "copilot-access-error", login: gh.login };
  }
  if (gh.status === "device-code" && gh.deviceCode) {
    return {
      kind: "github-device-code",
      code: gh.deviceCode,
      expired: gh.deviceCodeExpired ?? false,
    };
  }
  return gh.status === "signed-in" ? { kind: "ready" } : { kind: "start", error: gh.errorMessage };
}
