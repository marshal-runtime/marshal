import { Puzzle } from "@/components/icons";
import { Badge } from "@/components/marshal-ui/badge";
import { Switch } from "@/components/marshal-ui/marshal-switch";
import { extensionClient, SLOT_LABEL, useExtensions } from "@/extensions";

export function UiExtensionsTab() {
  const extensions = useExtensions();

  if (extensions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <Puzzle size={32} className="mx-auto mb-3 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">No UI plugins registered</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Register UI plugins in <code className="text-xs">src/extensions/registered.ts</code>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {extensions.map(({ manifest, enabled }) => (
        <div
          key={manifest.id}
          className="flex items-start gap-3 rounded-lg border border-border bg-card p-4 transition-colors"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Puzzle size={18} className="text-foreground-secondary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{manifest.displayName}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{manifest.id}</p>
              </div>
              <Switch
                checked={enabled}
                aria-label={`${manifest.displayName} — ${enabled ? "disable" : "enable"} plugin`}
                onCheckedChange={(checked) => {
                  if (checked) extensionClient.enable(manifest.id);
                  else extensionClient.disable(manifest.id);
                }}
              />
            </div>
            {manifest.description && (
              <p className="mt-1.5 text-xs text-foreground-secondary">{manifest.description}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
              {manifest.contributes.slots.map((slot) => (
                <Badge key={slot.slotId} variant="secondary" className="text-[10px]">
                  {SLOT_LABEL[slot.slotId]}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
