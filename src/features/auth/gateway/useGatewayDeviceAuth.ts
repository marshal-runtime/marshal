// Ownership: Gateway device authentication renderer module.
import type { GatewayAuthIdentity, GatewayAuthState } from "@common/marshal-ipc-contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

const DEFAULT_STATE: GatewayAuthState = { status: "picking" };
const QUERY_KEY = ["gateway-auth-state"] as const;

export function useGatewayAuth() {
  const queryClient = useQueryClient();

  const { data: state } = useQuery<GatewayAuthState>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      if (!window.gatewayAuthAPI) return DEFAULT_STATE;
      const res = await window.gatewayAuthAPI.getState();
      return res.success ? res.state : DEFAULT_STATE;
    },
    // State is push-driven via onStateChange; there's nothing to refetch.
    staleTime: Infinity,
    enabled: !!window.gatewayAuthAPI,
  });

  useEffect(() => {
    if (!window.gatewayAuthAPI?.onStateChange) return undefined;
    return window.gatewayAuthAPI.onStateChange((next) => {
      queryClient.setQueryData<GatewayAuthState>(QUERY_KEY, next);
    });
  }, [queryClient]);

  // useMutation (not useCallback) so we get:
  //  - `isPending` for the "connecting" UI state — no race against the
  //    IPC push event arriving before the next re-render.
  //  - Rejections surface as `isError` + last error object, not silently
  //    swallowed by a `void signIn(cred)` caller.
  const signInMutation = useMutation({
    mutationFn: async (cred: GatewayAuthIdentity) => {
      if (!window.gatewayAuthAPI) throw new Error("gatewayAuthAPI unavailable");
      return window.gatewayAuthAPI.signIn(cred);
    },
  });

  const signOutMutation = useMutation({
    mutationFn: async () => {
      if (!window.gatewayAuthAPI) throw new Error("gatewayAuthAPI unavailable");
      return window.gatewayAuthAPI.signOut();
    },
  });

  const cancelPairingMutation = useMutation({
    mutationFn: async () => {
      if (!window.gatewayAuthAPI) throw new Error("gatewayAuthAPI unavailable");
      return window.gatewayAuthAPI.cancelPairing();
    },
  });

  const current = state ?? DEFAULT_STATE;
  return {
    status: current.status,
    identity: current.identity,
    error: current.error,
    pairingRequestId: current.pairingRequestId,
    /** True while a previously-connected gateway socket (operator and/or
     *  node) is in its reconnect loop after a post-sign-in WS drop. Drives
     *  the "Reconnecting…" banner. Independent of ``status`` — status
     *  stays at "signed-in" through the whole reconnect cycle. */
    reconnecting: current.reconnecting ?? false,
    /** signIn's promise stays pending across the pairing wait — don't reuse
     *  this for the pairing-cancel button (use cancelPairingPending instead). */
    isPending: signInMutation.isPending || signOutMutation.isPending,
    cancelPairingPending: cancelPairingMutation.isPending,
    signIn: signInMutation.mutateAsync,
    signOut: signOutMutation.mutateAsync,
    cancelPairing: cancelPairingMutation.mutateAsync,
  };
}
