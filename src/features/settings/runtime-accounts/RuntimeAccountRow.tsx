import type {
  RuntimeAccountView,
  RuntimeAccountsView,
  RuntimeAuthLoginRequest,
  RuntimeAuthLoginState,
} from "@common/marshal-ipc-contract";
import { useState } from "react";

import { Ellipsis } from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SignOutConfirmDialog } from "@/shell/presentation/SignOutConfirmDialog";

import { AccountNameDialog } from "./AccountNameDialog";
import { AccountSignInDialog } from "./AccountSignInDialog";
import { AccountUsageMeter } from "./AccountUsageMeter";
import {
  useRuntimeAccountMutations,
  useRuntimeAccountStatus,
  useRuntimeAccountUsage,
} from "./queries";

type PendingLogin = Extract<RuntimeAuthLoginState, { status: "pending" }>;
type ConfirmAction = "sign-out" | "remove";

export function RuntimeAccountRow({
  runtime,
  account,
  enabled,
}: {
  runtime: RuntimeAccountsView;
  account: RuntimeAccountView;
  enabled: boolean;
}) {
  const ids = { runtimeId: runtime.runtimeId, accountId: account.id };
  const { login, signOut, rename, remove, setDefault } = useRuntimeAccountMutations();
  const [signInOpen, setSignInOpen] = useState(false);
  const [pendingLogin, setPendingLogin] = useState<PendingLogin>();
  const [renameOpen, setRenameOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const status = useRuntimeAccountStatus(runtime.runtimeId, account.id, {
    enabled,
    polling: signInOpen && !!pendingLogin,
  });
  const signedIn = status.data?.isAuthenticated === true;
  const usage = useRuntimeAccountUsage(runtime.runtimeId, account.id, {
    enabled: enabled && signedIn,
  });
  const needsReauth =
    signedIn && usage.data?.available === false && usage.data.reason === "auth_expired";
  const busy = signOut.isPending || remove.isPending || setDefault.isPending;

  const openSignIn = () => {
    login.reset();
    setPendingLogin(undefined);
    setSignInOpen(true);
  };
  const submitLogin = (request: RuntimeAuthLoginRequest) =>
    login.mutate(
      { ...ids, request },
      {
        onSuccess: (state) => {
          if (state.status === "pending") setPendingLogin(state);
          else setSignInOpen(false);
        },
      },
    );

  const actionError = signOut.error ?? remove.error ?? setDefault.error;
  return (
    <div
      className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/20 px-4 py-3"
      data-testid={`runtime-account-${account.targetKey}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">{account.label}</span>
          {account.isDefault && <Badge variant="secondary">Default</Badge>}
        </div>
        <span className="text-xs text-muted-foreground">
          <StatusText status={status} needsReauth={needsReauth} />
          {" · "}
          <code className="font-mono">{account.targetKey}:&lt;model&gt;</code>
        </span>
        {signedIn && (
          <AccountUsageMeter
            usage={usage.data}
            isPending={usage.isPending}
            isError={usage.isError}
            now={usage.dataUpdatedAt}
          />
        )}
        {actionError && (
          <span role="alert" className="text-xs text-destructive">
            {actionError.message}
          </span>
        )}
      </div>
      {((!signedIn && !status.isPending) || needsReauth) && (
        <Button size="sm" variant="outline" disabled={busy} onClick={openSignIn}>
          {needsReauth ? "Sign in again" : "Sign in"}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`${account.label} account actions`}
            disabled={busy}
          >
            <Ellipsis className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!account.isDefault && (
            <DropdownMenuItem onSelect={() => setDefault.mutate(ids)}>
              Make default
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>Rename</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void status.refetch();
              void usage.refetch();
            }}
          >
            Check status
          </DropdownMenuItem>
          {signedIn ? (
            <DropdownMenuItem onSelect={() => setConfirm("sign-out")}>Sign out</DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={openSignIn}>Sign in</DropdownMenuItem>
          )}
          {!account.isOriginal && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("remove")}>
                Remove
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {signInOpen && (
        <AccountSignInDialog
          runtime={runtime}
          account={account}
          open={!(pendingLogin && signedIn)}
          pendingState={pendingLogin}
          submitting={login.isPending}
          error={login.error?.message}
          onOpenChange={(open) => {
            if (!open) setSignInOpen(false);
          }}
          onLogin={submitLogin}
        />
      )}
      {renameOpen && (
        <AccountNameDialog
          open
          title={`Rename ${account.label}`}
          description="The name only labels this account in Marshal."
          confirmLabel="Rename"
          initialName={account.label}
          pending={rename.isPending}
          error={rename.error?.message}
          onOpenChange={setRenameOpen}
          onConfirm={(label) =>
            rename.mutate({ ...ids, label }, { onSuccess: () => setRenameOpen(false) })
          }
        />
      )}
      <SignOutConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        onConfirm={() => (confirm === "remove" ? remove.mutate(ids) : signOut.mutate(ids))}
        title={
          confirm === "remove"
            ? `Remove ${account.label}?`
            : `Sign ${account.label} out of ${runtime.displayName}?`
        }
        description={
          confirm === "remove"
            ? `Marshal signs this account out and forgets it. Sessions that name ${account.targetKey} stop working until you add it again.`
            : "Sessions already running on this account keep their sign-in until Marshal restarts."
        }
        confirmLabel={confirm === "remove" ? "Remove" : "Sign out"}
      />
    </div>
  );
}

function StatusText({
  status,
  needsReauth,
}: {
  status: ReturnType<typeof useRuntimeAccountStatus>;
  needsReauth: boolean;
}) {
  if (status.isPending) return <>Checking sign-in…</>;
  if (status.isError) return <>Sign-in status unavailable</>;
  if (!status.data.isAuthenticated) return <>Not signed in</>;
  if (needsReauth) return <>Sign-in expired — sign in again</>;
  return <>Signed in{status.data.login ? ` (${status.data.login})` : ""}</>;
}
