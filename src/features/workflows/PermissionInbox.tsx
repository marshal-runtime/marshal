// src/features/workflows/PermissionInbox.tsx
//
// Renders the per-run notification region for `mode: "ask"` workflows
// (R1-FIXES A10). Dual-routed `workflow:permission-request` events are
// pushed here from the engine. Operators click Allow / Deny; the response
// goes back through `workflows:permissionResponse` and the engine completes
// the original `copilot:resolvePermission` cycle on the subagent.

import { ShieldAlert } from "@/components/icons";

import { Button } from "@/components/marshal-ui/marshal-button";
import { Card } from "@/components/ui/card";

import { usePermissionInbox, type PermissionInboxItem } from "./useWorkflowEvents";

interface PermissionInboxProps {
  /** Optionally scope to a single run; otherwise shows all pending cards. */
  runId?: string;
}

export function PermissionInbox({ runId }: PermissionInboxProps) {
  const { items, respond } = usePermissionInbox();
  const scoped = runId ? items.filter((i) => i.runId === runId) : items;
  if (scoped.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-b border-border bg-(--brand-subtle) px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlert className="size-4" />
        Permission requests ({scoped.length})
      </div>
      <ul className="flex flex-col gap-2">
        {scoped.map((item) => (
          <PermissionRow key={item.id} item={item} respond={respond} />
        ))}
      </ul>
    </div>
  );
}

function PermissionRow({
  item,
  respond,
}: {
  item: PermissionInboxItem;
  respond: (item: PermissionInboxItem, allow: boolean) => Promise<void>;
}) {
  const card =
    item.cardPayload && typeof item.cardPayload === "object"
      ? (item.cardPayload as { title?: unknown; message?: unknown; detail?: unknown })
      : null;
  const title = typeof card?.title === "string" ? card.title : `Subagent ${item.subagentSessionId}`;
  const message = typeof card?.message === "string" ? card.message : undefined;
  const detail = typeof card?.detail === "string" ? card.detail : undefined;
  return (
    <Card className="flex items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{title}</div>
        {message && <div className="truncate text-xs text-muted-foreground">{message}</div>}
        <div className="truncate text-xs text-muted-foreground">
          {detail || `Run ${item.runId}`}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="ghost" onClick={() => void respond(item, false)}>
          Deny
        </Button>
        <Button size="sm" onClick={() => void respond(item, true)}>
          Allow
        </Button>
      </div>
    </Card>
  );
}
