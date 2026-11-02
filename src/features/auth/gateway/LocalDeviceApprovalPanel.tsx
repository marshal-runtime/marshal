import { Loader2, ShieldCheck } from "@/components/icons";
import { Alert, AlertDescription } from "@/components/marshal-ui/alert";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { useLocalDeviceApprovals } from "./useLocalGatewayDeviceApprovals";

export function LocalDeviceApprovalPanel() {
  const { isLocal, pending, isLoading, approving, approveError, approve, refresh } =
    useLocalDeviceApprovals();

  if (!isLocal || pending.length === 0 || isLoading) return null;

  return (
    <Card
      data-testid="local-device-approval-panel"
      className="border-amber-500/50 bg-amber-50/40 dark:bg-amber-950/10"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="size-4 text-amber-600" aria-hidden="true" />
          Pending device approvals
        </CardTitle>
        <Button
          size="sm"
          variant="ghost"
          onClick={refresh}
          disabled={approving}
          data-testid="local-device-approval-refresh"
        >
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {approveError ? (
          <Alert variant="destructive" data-testid="local-device-approval-error">
            <AlertDescription>{approveError}</AlertDescription>
          </Alert>
        ) : null}
        <ul className="space-y-2">
          {pending.map((req) => (
            <li
              key={req.requestId}
              className="flex items-start justify-between gap-3 rounded-md border border-border bg-background/60 px-3 py-2 text-sm"
              data-testid={`pending-device-${req.requestId}`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-medium">{req.displayName ?? req.deviceId}</span>
                <span className="text-xs text-muted-foreground">
                  <code className="font-mono">{req.requestId}</code>
                  {req.role ? <> · {req.role}</> : null}
                </span>
                {req.scopes && req.scopes.length > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    Scopes: {req.scopes.join(", ")}
                  </span>
                ) : null}
              </div>
              <Button
                size="sm"
                onClick={() => {
                  approve(req.requestId);
                }}
                disabled={approving}
                aria-label={`Approve ${req.displayName ?? req.deviceId}`}
                data-testid={`approve-device-${req.requestId}`}
              >
                {approving ? (
                  <>
                    <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden="true" />
                    Approving…
                  </>
                ) : (
                  "Approve"
                )}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
