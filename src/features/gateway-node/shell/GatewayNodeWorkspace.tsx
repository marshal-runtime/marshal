import type { GatewayAuthIdentity } from "@common/marshal-ipc-contract";

import { Button } from "@/components/marshal-ui/marshal-button";

import { GatewayNodeActivityList } from "../GatewayNodeActivityList";

interface GatewayNodeWorkspaceProps {
  identity: GatewayAuthIdentity | undefined;
  onSignOut: () => void;
}

export function GatewayNodeWorkspace({ identity, onSignOut }: GatewayNodeWorkspaceProps) {
  const nodeName = identity?.nodeName?.trim() || "this device";

  return (
    <div className="flex size-full flex-col bg-muted/20">
      <header className="border-b bg-background px-8 py-6">
        <div className="mx-auto flex w-full max-w-5xl items-start justify-between gap-6">
          <div className="flex items-start gap-4">
            <div
              aria-hidden="true"
              className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
            >
              <span className="size-2.5 rounded-full bg-current" />
            </div>
            <div>
              <p className="text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase">
                Gateway workspace
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Gateway node workspace</h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Review this device's gateway node activity and identity details.
              </p>
            </div>
          </div>
          <Button variant="outline" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="flex-1 overflow-auto px-8 py-7">
        <div className="mx-auto w-full max-w-5xl">
          <section
            aria-labelledby="gateway-node-identity"
            className="mb-6 rounded-2xl border bg-background p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
                  Node identity
                </p>
                <h2 id="gateway-node-identity" className="mt-1 text-lg font-semibold">
                  {nodeName}
                </h2>
              </div>
              <p className="rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                Node activity
              </p>
            </div>
          </section>
          <section aria-labelledby="gateway-node-activity">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="gateway-node-activity" className="text-sm font-semibold">
                Recent activity
              </h2>
              <span className="text-xs text-muted-foreground">Activity history</span>
            </div>
            <GatewayNodeActivityList />
          </section>
        </div>
      </main>
    </div>
  );
}
