import type { RuntimeAccountUsage, RuntimeUsageWindow } from "@common/runtime-account-usage";

import { Badge } from "@/components/marshal-ui/badge";
import { Progress } from "@/components/marshal-ui/progress";
import { cn } from "@/lib/marshal-class-names";

import { formatUsageReset, sortUsageWindows, usageWindowLabel } from "./usage-format";

const HIGH_USAGE_PERCENT = 90;

function UsageBar({ window, now }: { window: RuntimeUsageWindow; now: number }) {
  const label = usageWindowLabel(window);
  const reset = formatUsageReset(window.resetsAt, now);
  const percent = Math.round(window.usedPercent);
  return (
    <div className="flex items-center gap-2 text-xs" data-testid={`usage-window-${window.kind}`}>
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <Progress
        value={window.usedPercent}
        aria-label={`${label} usage`}
        className={cn(
          "h-1.5 max-w-40 flex-1",
          window.usedPercent >= HIGH_USAGE_PERCENT &&
            "**:data-[slot=progress-indicator]:bg-destructive",
        )}
      />
      <span className="w-10 shrink-0 text-right text-foreground tabular-nums">{percent}%</span>
      {reset && <span className="truncate text-muted-foreground">{reset}</span>}
    </div>
  );
}

export function AccountUsageMeter({
  usage,
  isPending,
  isError,
  now,
}: {
  usage: RuntimeAccountUsage | undefined;
  isPending: boolean;
  isError: boolean;
  now: number;
}) {
  if (isPending) return <span className="text-xs text-muted-foreground">Loading usage…</span>;
  if (isError || !usage) {
    return <span className="text-xs text-muted-foreground">Usage unavailable</span>;
  }
  if (!usage.available) {
    if (usage.reason === "signed_out") return null;
    return (
      <span className="text-xs text-muted-foreground">
        {usage.reason === "not_applicable"
          ? (usage.message ?? "Plan usage isn't reported for this account")
          : (usage.message ?? "Usage unavailable")}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="account-usage">
      {usage.plan && (
        <div>
          <Badge variant="secondary" className="capitalize">
            {usage.plan} plan
          </Badge>
        </div>
      )}
      {usage.windows.length === 0 ? (
        <span className="text-xs text-muted-foreground">No usage windows reported</span>
      ) : (
        sortUsageWindows(usage.windows).map((window) => (
          <UsageBar key={`${window.kind}:${window.label ?? ""}`} window={window} now={now} />
        ))
      )}
    </div>
  );
}
