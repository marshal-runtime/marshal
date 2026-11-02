import type { RuntimeAccountsView } from "@common/marshal-ipc-contract";
import { useState } from "react";

import { Plus } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";

import { AccountNameDialog } from "./AccountNameDialog";
import { useRuntimeAccountMutations, useRuntimeAccounts } from "./queries";
import { RuntimeAccountRow } from "./RuntimeAccountRow";

export function RuntimeAccountsSection({ isOpen }: { isOpen: boolean }) {
  const accounts = useRuntimeAccounts(isOpen);
  if (!window.runtimeAccountsAPI) return null;
  return (
    <div className="flex flex-col gap-5" data-testid="runtime-accounts-section">
      <p className="max-w-2xl text-xs/5 text-muted-foreground">
        Sign in more than one account per runtime and run them side by side. Plain models use the
        runtime&apos;s default account; a model like{" "}
        <code className="font-mono">claude@work:opus</code> runs a session, subagent, or workflow
        step on a specific account.
      </p>
      {accounts.isPending && <p className="text-xs text-muted-foreground">Loading accounts…</p>}
      {accounts.error && (
        <p role="alert" className="text-sm text-destructive">
          {accounts.error.message}
        </p>
      )}
      {accounts.data?.map((runtime) => (
        <RuntimeAccountsGroup key={runtime.runtimeId} runtime={runtime} enabled={isOpen} />
      ))}
    </div>
  );
}

function RuntimeAccountsGroup({
  runtime,
  enabled,
}: {
  runtime: RuntimeAccountsView;
  enabled: boolean;
}) {
  const { add } = useRuntimeAccountMutations();
  const [addOpen, setAddOpen] = useState(false);
  return (
    <section
      className="flex flex-col gap-2"
      aria-label={`${runtime.displayName} accounts`}
      data-testid={`runtime-accounts-${runtime.runtimeId}`}
    >
      <div className="flex items-center justify-between">
        <h4 className="text-[13px] font-semibold text-foreground">{runtime.displayName}</h4>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            add.reset();
            setAddOpen(true);
          }}
        >
          <Plus className="size-3.5" />
          Add account
        </Button>
      </div>
      {runtime.accounts.map((account) => (
        <RuntimeAccountRow key={account.id} runtime={runtime} account={account} enabled={enabled} />
      ))}
      {addOpen && (
        <AccountNameDialog
          open
          title={`Add a ${runtime.displayName} account`}
          description="Name the account, then sign in to it. Its sign-in is kept apart from your other accounts."
          confirmLabel="Add account"
          pending={add.isPending}
          error={add.error?.message}
          onOpenChange={setAddOpen}
          onConfirm={(label) =>
            add.mutate(
              { runtimeId: runtime.runtimeId, label },
              { onSuccess: () => setAddOpen(false) },
            )
          }
        />
      )}
    </section>
  );
}
