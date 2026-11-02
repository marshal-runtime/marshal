/**
 * useAuthFlow — GitHub auth state machine.
 *
 * Derives a single discriminated-union `stage` from useGitHubAuth, plus the
 * actions the auth screen needs.
 */

import { deriveStage, type AuthStage } from "./deriveStage";
import { useGitHubAuth } from "./useGitHubDeviceAuth";

export type { AuthStage };

export interface UseAuthFlowResult {
  stage: AuthStage;
  actions: {
    signInGitHub: () => Promise<void>;
    signOutAll: () => Promise<void>;
    /** Clear transient error state; useful from recovery cards. Synchronous —
     *  just state setters on the underlying hook. */
    reset: () => void;
  };
}

export function useAuthFlow(): UseAuthFlowResult {
  const gh = useGitHubAuth();

  const stage: AuthStage = deriveStage({
    gh: {
      status: gh.status,
      login: gh.login,
      copilotPlan: gh.copilotPlan,
      deviceCode: gh.deviceCode,
      deviceCodeExpired: gh.deviceCodeExpired,
      errorMessage: gh.errorMessage,
    },
  });

  return {
    stage,
    actions: {
      signInGitHub: async () => {
        await gh.actions.startDeviceFlow();
      },
      signOutAll: async () => {
        try {
          await gh.actions.signOut();
        } catch {
          /* errors surface via hook state */
        }
      },
      reset: gh.actions.reset,
    },
  };
}
