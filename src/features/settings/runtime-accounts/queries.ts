import type {
  RuntimeAccountView,
  RuntimeAccountsView,
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginState,
  RuntimeAuthStatus,
} from "@common/marshal-ipc-contract";
import type { RuntimeAccountUsage } from "@common/runtime-account-usage";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const ROOT_KEY = ["runtime-accounts"] as const;
const LIST_KEY = [...ROOT_KEY, "list"] as const;

function statusKey(runtimeId: string, accountId: string) {
  return [...ROOT_KEY, "status", runtimeId, accountId] as const;
}

function usageKey(runtimeId: string, accountId: string) {
  return [...ROOT_KEY, "usage", runtimeId, accountId] as const;
}

function api() {
  const value = window.runtimeAccountsAPI;
  if (!value) throw new Error("Runtime accounts are unavailable");
  return value;
}

function unwrap<T extends { success: boolean; error?: string }>(result: T, fallback: string): T {
  if (!result.success) throw new Error(result.error ?? fallback);
  return result;
}

export function useRuntimeAccounts(enabled: boolean) {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async (): Promise<RuntimeAccountsView[]> =>
      unwrap(await api().list(), "Failed to load runtime accounts").runtimes ?? [],
    enabled: enabled && !!window.runtimeAccountsAPI,
  });
}

/** Each check starts a short-lived runtime client, so statuses are cached and polled only mid-sign-in. */
export function useRuntimeAccountStatus(
  runtimeId: string,
  accountId: string,
  { enabled, polling }: { enabled: boolean; polling: boolean },
) {
  return useQuery({
    queryKey: statusKey(runtimeId, accountId),
    queryFn: async (): Promise<RuntimeAuthStatus> => {
      const result = unwrap(await api().getStatus(runtimeId, accountId), "Status check failed");
      if (!result.status) throw new Error("Status check failed");
      return result.status;
    },
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (polling && !query.state.data?.isAuthenticated ? 3_000 : false),
  });
}

/** Main caches reads for a minute, so refetching while Settings is open costs one read per account at most. */
export function useRuntimeAccountUsage(
  runtimeId: string,
  accountId: string,
  { enabled }: { enabled: boolean },
) {
  return useQuery({
    queryKey: usageKey(runtimeId, accountId),
    queryFn: async (): Promise<RuntimeAccountUsage> => {
      const result = unwrap(await api().getUsage(runtimeId, accountId), "Usage read failed");
      if (!result.usage) throw new Error("Usage read failed");
      return result.usage;
    },
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: 60_000,
  });
}

export function useRuntimeAccountMutations() {
  const queryClient = useQueryClient();
  const refreshList = () => queryClient.invalidateQueries({ queryKey: LIST_KEY });
  const refreshStatus = (runtimeId: string, accountId: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: statusKey(runtimeId, accountId) }),
      queryClient.invalidateQueries({ queryKey: usageKey(runtimeId, accountId) }),
    ]);

  const add = useMutation({
    mutationFn: async ({ runtimeId, label }: { runtimeId: string; label: string }) => {
      const result = unwrap(await api().add(runtimeId, label), "Failed to add account");
      if (!result.account) throw new Error("Failed to add account");
      return result.account satisfies RuntimeAccountView;
    },
    onSettled: refreshList,
  });

  const rename = useMutation({
    mutationFn: async (input: { runtimeId: string; accountId: string; label: string }) => {
      unwrap(
        await api().rename(input.runtimeId, input.accountId, input.label),
        "Failed to rename account",
      );
    },
    onSettled: refreshList,
  });

  const remove = useMutation({
    mutationFn: async ({ runtimeId, accountId }: { runtimeId: string; accountId: string }) => {
      unwrap(await api().remove(runtimeId, accountId), "Failed to remove account");
    },
    onSettled: async (_data, _error, { runtimeId, accountId }) => {
      queryClient.removeQueries({ queryKey: statusKey(runtimeId, accountId) });
      queryClient.removeQueries({ queryKey: usageKey(runtimeId, accountId) });
      await refreshList();
    },
  });

  const setDefault = useMutation({
    mutationFn: async ({ runtimeId, accountId }: { runtimeId: string; accountId: string }) => {
      unwrap(await api().setDefault(runtimeId, accountId), "Failed to change default account");
    },
    onSettled: refreshList,
  });

  const login = useMutation({
    mutationFn: async (input: {
      runtimeId: string;
      accountId: string;
      request: RuntimeAuthLoginRequest;
    }): Promise<RuntimeAuthLoginState> => {
      const result = unwrap(
        await api().login(input.runtimeId, input.accountId, input.request),
        "Sign-in failed",
      );
      if (!result.state) throw new Error("Sign-in failed");
      return result.state;
    },
    onSettled: (_data, _error, { runtimeId, accountId }) => refreshStatus(runtimeId, accountId),
  });

  const signOut = useMutation({
    mutationFn: async ({ runtimeId, accountId }: { runtimeId: string; accountId: string }) => {
      unwrap(await api().signOut(runtimeId, accountId), "Sign-out failed");
    },
    onSettled: (_data, _error, { runtimeId, accountId }) => refreshStatus(runtimeId, accountId),
  });

  return { add, rename, remove, setDefault, login, signOut };
}
