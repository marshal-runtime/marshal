import { toMcpServerKey } from "@common/mcp-server-key-normalization";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { Input } from "@/components/marshal-ui/input";
import { Label } from "@/components/marshal-ui/label";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { mcpOAuthStore, type McpOAuthPromptRequest } from "@/hooks/mcp-oauth-store";
import { InteractiveElementMonitor_SignIn } from "@/services/telemetry/schema";
import { useIdentity } from "@/shared/hooks/useIdentity";

function getAliasFromAccountName(accountName: string | null | undefined): string {
  return accountName?.trim() ?? "";
}

interface SignInVars {
  serverKey: string;
  serverName: string;
  loginHint: string;
  contextSessionId?: string;
  forceReauth?: boolean;
}

/**
 * Host that subscribes to the OAuth prompt store and remounts the inner dialog
 * (via a `key` derived from the server name) whenever the request switches to
 * a different server. The remount lets the inner dialog be a pure component
 * with no `useRef` / `useEffect` machinery to reset local state — React handles
 * it for us by unmounting the old instance.
 */
export function McpOAuthDialog() {
  const request = useSyncExternalStore(mcpOAuthStore.subscribe, mcpOAuthStore.getPromptSnapshot);
  if (!request) return null;
  return <McpOAuthDialogContent key={toMcpServerKey(request.serverName)} request={request} />;
}

function McpOAuthDialogContent({ request }: { request: McpOAuthPromptRequest }) {
  const identity = useIdentity();
  const queryClient = useQueryClient();

  const identityAlias = useMemo(
    () => getAliasFromAccountName(identity.accountName),
    [identity.accountName],
  );
  const [aliasOverride, setAliasOverride] = useState<string | null>(null);

  const signIn = useMutation({
    mutationFn: async (vars: SignInVars) => {
      // contextSessionId pins the OAuth RPC to the originating session;
      // forceReauth tells the handler to drop cached tokens regardless of
      // whether the user typed an alias. Pass {} when both unset so the
      // handler's older loginHint-only heuristic kicks in.
      const result = await window.mcpsAPI?.initiateOAuth(
        vars.serverName,
        vars.loginHint || undefined,
        {
          contextSessionId: vars.contextSessionId,
          forceReauth: vars.forceReauth,
        },
      );
      if (!result) throw new Error("MCP OAuth is not available");
      if (result.status === "error") throw new Error(result.message);
      return result;
    },
    onMutate: (vars) => {
      mcpOAuthStore.setUiState(vars.serverKey, {
        serverKey: vars.serverKey,
        state: "connecting",
        alias: vars.loginHint || undefined,
      });
    },
    onSuccess: (result, vars) => {
      const signedInAlias = result.oauthAlias ?? (vars.loginHint || undefined);
      mcpOAuthStore.setUiState(vars.serverKey, {
        serverKey: vars.serverKey,
        state: "connected",
        alias: signedInAlias,
      });
      toast.success(`Signed in to MCP server "${vars.serverName}"`);
      mcpOAuthStore.close();
    },
    onError: (err, vars) => {
      const message = err instanceof Error ? err.message : String(err);
      mcpOAuthStore.setUiState(vars.serverKey, {
        serverKey: vars.serverKey,
        state: "failed",
        alias: vars.loginHint || undefined,
        error: message,
      });
    },
    // Invalidate on settled (success OR error) so the renderer's view of MCP
    // server status refreshes even if the IPC throws after the SDK has
    // already mutated token state. Matches the defensive pattern
    // `useSignOutMcpServerMutation` uses for the same reason. Returning the
    // promise lets TanStack await the refetch so `signIn.isPending` stays
    // true until the cache catches up.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });

  const serverKey = toMcpServerKey(request.serverName);
  const isChatRequired = request.blocking ?? request.reason === "chat-required";
  const isSwitch = request.reason === "switch";
  const isRetry = request.reason === "retry";
  const title = isSwitch
    ? `Re-authenticate with ${request.serverName}`
    : `Sign in to ${request.serverName}`;
  const description = isChatRequired
    ? `Marshal needs you to sign in to ${request.serverName} before this MCP server can be used.`
    : `Choose the account Marshal should use for this MCP server.`;
  const defaultAlias = request.defaultLoginHint
    ? getAliasFromAccountName(request.defaultLoginHint)
    : identityAlias;
  const alias = aliasOverride ?? defaultAlias;
  const errorMessage =
    signIn.error instanceof Error
      ? signIn.error.message
      : signIn.error
        ? String(signIn.error)
        : null;

  const handleCancel = () => {
    mcpOAuthStore.setUiState(serverKey, { serverKey, state: "idle" });
    mcpOAuthStore.close();
  };

  const handleSignIn = () => {
    signIn.mutate({
      serverKey,
      serverName: request.serverName,
      loginHint: alias.trim(),
      contextSessionId: request.contextSessionId,
      forceReauth: request.forceReauth,
    });
  };

  const submitLabel = signIn.isPending
    ? "Connecting..."
    : isSwitch
      ? "Re-authenticate"
      : isRetry
        ? "Try again"
        : "Sign in";

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open && !signIn.isPending) handleCancel();
      }}
    >
      <DialogContent className="max-w-[440px]!">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="mcp-oauth-alias">Username or alias</Label>
          <Input
            id="mcp-oauth-alias"
            className="rounded-xl"
            placeholder="alias or user@domain.com"
            value={alias}
            disabled={signIn.isPending}
            onChange={(event) => setAliasOverride(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !signIn.isPending) {
                event.preventDefault();
                handleSignIn();
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            Optional. You can enter an alias or full email address.
          </p>
          {errorMessage && (
            <p role="alert" className="text-xs text-destructive">
              {errorMessage}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={signIn.isPending} onClick={handleCancel}>
            Cancel
          </Button>
          <InteractiveElementMonitor_SignIn callback={handleSignIn}>
            {(cb) => (
              <Button
                className="bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
                disabled={signIn.isPending}
                onClick={cb}
              >
                {submitLabel}
              </Button>
            )}
          </InteractiveElementMonitor_SignIn>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
