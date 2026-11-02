/**
 * useIdentity — backend-agnostic user identity.
 *
 * The main process composes a `UserIdentity` from the active backend (Copilot
 * auth / Gateway auth) + shared relay state; this hook fetches that
 * shape and subscribes to push updates. PersonContextMenu consumes only the
 * composed object so no `if (isGateway)` branching lives in the UI.
 *
 * Per the Phase 2 backend-abstraction spec: "Renderer checks
 * BackendCapabilities, never backend identity."
 */

import type { UserIdentity } from "@common/marshal-ipc-contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

const DEFAULT_IDENTITY: UserIdentity = {
  isAuthenticated: false,
  displayName: "Signed in",
  subtitle: null,
  accountName: null,
  avatarUrl: null,
  statusColor: "muted",
  statusText: "",
  integrations: [],
  signOut: {
    title: "Sign out?",
    description: "",
    confirmLabel: "Sign out",
  },
};

const QUERY_KEY = ["user-identity"] as const;

const identityQueryFn = async (): Promise<UserIdentity> => {
  if (!window.identityAPI) return DEFAULT_IDENTITY;
  const res = await window.identityAPI.get();
  return res.success ? res.identity : DEFAULT_IDENTITY;
};

const QUERY_OPTIONS = {
  queryKey: QUERY_KEY,
  queryFn: identityQueryFn,
  // Push-driven for the auth transitions we control (gateway sign-in/out).
  // For GitHub auth changes that are still poll-based, we
  // refetch on a long interval as a safety net — the initial state on mount
  // is the primary signal.
  staleTime: 30_000,
  refetchInterval: 30_000,
} as const;

export function useIdentity(): UserIdentity {
  const queryClient = useQueryClient();

  const { data } = useQuery<UserIdentity>({
    ...QUERY_OPTIONS,
    enabled: !!window.identityAPI,
  });

  useEffect(() => {
    if (!window.identityAPI?.onChange) return undefined;
    return window.identityAPI.onChange((next) => {
      queryClient.setQueryData<UserIdentity>(QUERY_KEY, next);
    });
  }, [queryClient]);

  return data ?? DEFAULT_IDENTITY;
}
