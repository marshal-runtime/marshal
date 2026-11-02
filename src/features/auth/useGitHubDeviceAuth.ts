/**
 * useGitHubAuth — single owner of GitHub/Copilot auth state for the renderer.
 *
 * Derives a discriminated-union `status` from window.copilotAPI.checkAuth() +
 * window.modelsAPI.list() (the existing Copilot-entitlement check) plus any
 * in-flight device-code flow.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { AUTH_KEYS, overwriteAuthCache } from "./cache";

export type GitHubAuthStatus =
  | "checking"
  | "signed-out"
  | "device-code"
  | "signed-in"
  | "copilot-access-error"
  | "not-allowed-plan";

// Slightly longer than the backend's 2-min `copilot login` lifetime cap, so
// a late success poll still wins over the renderer-side expiry.
const DEVICE_CODE_EXPIRY_MS = 2.5 * 60_000;

// Raw `copilot_plan` values from GitHub's Copilot user API. The two
// organizational tiers are "enterprise" and "business" (verified against
// the bundled @github/copilot SDK); individual_* plans are rejected.
const ALLOWED_DEVICE_COPILOT_PLANS = ["enterprise", "business"];

export interface UseGitHubAuthResult {
  status: GitHubAuthStatus;
  login: string | undefined;
  copilotPlan: string | undefined;
  deviceCode: string | undefined;
  deviceCodeExpired: boolean;
  errorMessage: string | undefined;
  actions: {
    /** Starts the GitHub device-code flow. Resolves `true` when the flow was
     *  initiated successfully (or the user was already authenticated), `false`
     *  if the IPC or startup failed. Callers use the boolean to decide whether
     *  to record session-local "flow entered via GitHub" state. Errors surface
     *  through `errorMessage`, not thrown. */
    startDeviceFlow: () => Promise<boolean>;
    signOut: () => Promise<void>;
    /** Clear any transient device-code / error state (e.g., after sign-out). */
    reset: () => void;
  };
}

interface AuthProbe {
  isAuthenticated: boolean;
  login?: string;
  copilotOk: boolean;
  copilotPlan?: string;
}

export function useGitHubAuth(): UseGitHubAuthResult {
  const qc = useQueryClient();
  const [deviceCode, setDeviceCode] = useState<string | undefined>(undefined);
  const [deviceCodeExpired, setDeviceCodeExpired] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!deviceCode) {
      // eslint-disable-next-line react-compiler/set-state-in-effect -- reset transient flag when the input clears
      setDeviceCodeExpired(false);
      return undefined;
    }
    const id = setTimeout(() => setDeviceCodeExpired(true), DEVICE_CODE_EXPIRY_MS);
    return () => clearTimeout(id);
  }, [deviceCode]);

  useEffect(() => {
    if (!window.copilotAPI?.onLoginFailed) return undefined;
    return window.copilotAPI.onLoginFailed(() => setDeviceCodeExpired(true));
  }, []);

  const probe = useQuery<AuthProbe>({
    queryKey: AUTH_KEYS.github,
    queryFn: async () => {
      const check = await window.copilotAPI.checkAuth();
      if (!check.isAuthenticated) {
        return { isAuthenticated: false, copilotOk: false };
      }
      try {
        const models = await window.modelsAPI?.list();
        const copilotOk = (models?.success ?? false) && (models.models?.length ?? 0) > 0;
        return {
          isAuthenticated: true,
          login: check.login,
          copilotOk,
          copilotPlan: check.copilotPlan,
        };
      } catch {
        return {
          isAuthenticated: true,
          login: check.login,
          copilotOk: false,
          copilotPlan: check.copilotPlan,
        };
      }
    },
    // Poll every 2s while device-code flow is active. Stop polling once auth
    // resolves so we don't keep hitting IPC forever after the flow completes.
    refetchInterval: (q) => {
      if (q.state.data?.isAuthenticated) return false;
      return deviceCode ? 2000 : false;
    },
  });

  // Drop the device code once the probe confirms sign-in. Without this, a
  // later mid-session token expiry would resurface a stale code via the
  // "device-code" branch of the status derivation.
  useEffect(() => {
    // eslint-disable-next-line react-compiler/set-state-in-effect -- sync local state with async probe result
    if (probe.data?.isAuthenticated) setDeviceCode(undefined);
  }, [probe.data?.isAuthenticated]);

  const startFlow = useMutation({
    mutationFn: async () => {
      const res = await window.copilotAPI.startDeviceFlow();
      if (res.isAuthenticated) {
        await qc.invalidateQueries({ queryKey: AUTH_KEYS.github });
        return;
      }
      if (res.needsDeviceFlow && res.deviceCode) {
        setDeviceCodeExpired(false);
        setDeviceCode(res.deviceCode);
        return;
      }
      // Any non-success response must reject so callers see a failure instead of
      // a flow with no device code.
      throw new Error(res.error ?? "Failed to start GitHub device flow");
    },
    onError: (err) => setErrorMessage(String(err)),
  });

  const signOut = useMutation({
    mutationFn: async () => {
      await window.copilotAPI.signOut?.();
    },
    onSuccess: async () => {
      setDeviceCode(undefined);
      setErrorMessage(undefined);
      await overwriteAuthCache(qc, AUTH_KEYS.github, {
        isAuthenticated: false,
        copilotOk: false,
      } satisfies AuthProbe);
    },
  });

  const status: GitHubAuthStatus = (() => {
    if (probe.isLoading) return "checking";
    const data = probe.data;
    // Auth results beat the transient device-code state — once we're signed
    // in (or have a Copilot-access error to show), the device-code card is
    // stale and must not win the stage derivation. This is what unsticks the
    // UI after the user pastes the code on github.com and completes auth.
    if (data?.isAuthenticated && data.copilotOk) {
      // Plan is only enforced when the backend probe succeeds (`copilotPlan`
      // is defined). Treat an undefined plan as "couldn't verify" and fall
      // through to signed-in so a transient SDK probe failure doesn't lock
      // the user out — the existing models-list gate above already rejects
      // accounts with no Copilot access at all.
      if (data.copilotPlan && !ALLOWED_DEVICE_COPILOT_PLANS.includes(data.copilotPlan)) {
        return "not-allowed-plan";
      }
      return "signed-in";
    }
    if (data?.isAuthenticated && !data.copilotOk) return "copilot-access-error";
    if (deviceCode) return "device-code";
    if (!data) return "checking";
    return "signed-out";
  })();

  return {
    status,
    login: probe.data?.login,
    copilotPlan: probe.data?.copilotPlan,
    deviceCode,
    deviceCodeExpired,
    errorMessage,
    actions: {
      startDeviceFlow: async () => {
        // Swallow the mutation rejection — the error is already surfaced via
        // `errorMessage` state (set in `startFlow.onError`). Re-throwing
        // would propagate to the async onClick in the start card and produce
        // an unhandled rejection in the browser console.
        try {
          await startFlow.mutateAsync();
          return true;
        } catch {
          return false;
        }
      },
      signOut: async () => {
        await signOut.mutateAsync();
      },
      reset: () => {
        setDeviceCode(undefined);
        setDeviceCodeExpired(false);
        setErrorMessage(undefined);
      },
    },
  };
}
