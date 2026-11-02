import type {
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginState,
  RuntimeAuthStatus,
} from "@common/marshal-ipc-contract";
import {
  getRuntimeMetadata,
  type RuntimeMetadata,
  type RuntimeAuthMethodMetadata,
} from "@common/runtime-config";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { overwriteAuthCache } from "../cache";

export type RuntimeAuthStage =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "setup-required"; message: string }
  | {
      kind: "sign-in";
      methods: readonly RuntimeAuthMethodMetadata[];
      message?: string;
      error?: string;
    }
  | {
      kind: "pending";
      method: "browser" | "device-code";
      verificationUri?: string;
      userCode?: string;
    }
  | { kind: "error"; message: string };

interface DeriveRuntimeAuthStageInput {
  metadata: RuntimeMetadata;
  status: RuntimeAuthStatus | undefined;
  statusPending: boolean;
  statusError: unknown;
  loginState: RuntimeAuthLoginState | null;
  loginError: unknown;
}

function errorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Runtime authentication failed";
}

export function deriveRuntimeAuthStage({
  metadata,
  status,
  statusPending,
  statusError,
  loginState,
  loginError,
}: DeriveRuntimeAuthStageInput): RuntimeAuthStage {
  if (status?.isAuthenticated || loginState?.status === "authenticated") {
    return { kind: "ready" };
  }
  if (loginState?.status === "pending") {
    return {
      kind: "pending",
      method: loginState.method,
      verificationUri: loginState.verificationUri,
      userCode: loginState.userCode,
    };
  }
  if (statusPending) return { kind: "checking" };
  const statusFailure = errorMessage(statusError);
  if (statusFailure) return { kind: "error", message: statusFailure };

  const loginFailure = errorMessage(loginError);
  if (metadata.auth.methods.length > 0) {
    return {
      kind: "sign-in",
      methods: metadata.auth.methods,
      message: status?.statusMessage,
      error: loginFailure,
    };
  }
  return {
    kind: "setup-required",
    message:
      status?.statusMessage ??
      metadata.auth.setupInstructions ??
      `Configure credentials for ${metadata.displayName}, then restart Marshal.`,
  };
}

export function useRuntimeAuth(runtimeId: string) {
  const metadata = getRuntimeMetadata(runtimeId);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["runtime-auth", metadata.id] as const, [metadata.id]);
  const [loginState, setLoginState] = useState<RuntimeAuthLoginState | null>(null);
  const [loginFailure, setLoginFailure] = useState<string | null>(null);
  const loginRequest = useRef<RuntimeAuthLoginRequest | null>(null);
  const loginInFlight = useRef(false);

  const statusQuery = useQuery({
    queryKey,
    queryFn: async (): Promise<RuntimeAuthStatus> => {
      if (!window.runtimeAuthAPI) throw new Error("Runtime authentication API is unavailable");
      const result = await window.runtimeAuthAPI.getStatus();
      if (!result.success || !result.status) {
        throw new Error(result.error ?? "Failed to check runtime authentication");
      }
      return result.status;
    },
    refetchInterval: (query) =>
      loginState?.status === "pending" && !query.state.data?.isAuthenticated ? 2_000 : false,
  });

  const loginMutation = useMutation({
    mutationFn: async () => {
      const request = loginRequest.current;
      loginRequest.current = null;
      if (!request) throw new Error("Runtime authentication request is unavailable");
      if (!window.runtimeAuthAPI) throw new Error("Runtime authentication API is unavailable");
      const result = await window.runtimeAuthAPI.login(request);
      if (!result.success || !result.state) {
        throw new Error(result.error ?? "Runtime authentication failed");
      }
      return result.state;
    },
    onSuccess: async (state) => {
      setLoginFailure(null);
      setLoginState(state);
      if (state.status === "authenticated") {
        await overwriteAuthCache(queryClient, queryKey, { isAuthenticated: true });
      } else {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });

  useEffect(() => {
    if (!window.runtimeAuthAPI?.onLoginFailed) return undefined;
    return window.runtimeAuthAPI.onLoginFailed((reason) => {
      setLoginState(null);
      setLoginFailure(reason);
      void queryClient.invalidateQueries({ queryKey });
    });
  }, [queryClient, queryKey]);

  const signOutMutation = useMutation({
    mutationFn: async () => {
      if (!window.runtimeAuthAPI) throw new Error("Runtime authentication API is unavailable");
      const result = await window.runtimeAuthAPI.signOut();
      if (!result.success) throw new Error(result.error ?? "Runtime sign-out failed");
      await overwriteAuthCache(queryClient, queryKey, { isAuthenticated: false });
    },
    onSuccess: () => {
      setLoginState(null);
      setLoginFailure(null);
    },
  });

  return {
    metadata,
    stage: deriveRuntimeAuthStage({
      metadata,
      status: statusQuery.data,
      statusPending: statusQuery.isPending,
      statusError: statusQuery.error,
      loginState,
      loginError: loginFailure ?? loginMutation.error,
    }),
    login: async (request: RuntimeAuthLoginRequest) => {
      if (loginInFlight.current) throw new Error("Runtime authentication is already in progress");
      loginInFlight.current = true;
      loginRequest.current = request;
      try {
        await loginMutation.mutateAsync();
      } finally {
        loginRequest.current = null;
        loginInFlight.current = false;
        loginMutation.reset();
      }
    },
    signOut: () => signOutMutation.mutate(),
    retry: () => void statusQuery.refetch(),
    isLoginPending: loginMutation.isPending,
  };
}

export type UseRuntimeAuthResult = ReturnType<typeof useRuntimeAuth>;
