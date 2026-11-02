import { useState } from "react";

import { Check, Copy, Loader2, ShieldCheck } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useTimeout } from "@/runtime-ui/hooks/use-timeout";
import { InteractiveElementMonitor_Copy } from "@/services/telemetry/schema";

interface PairingDialogProps {
  /** Null briefly between the status flip and the requestId push — the
   *  dialog falls back to a "Connecting…" placeholder rather than dropping. */
  requestId: string | null;
  onCancel: () => void;
  cancelPending?: boolean;
  cancelError?: string;
}

/** Modal-locked: cancel via the explicit button, not Escape / outside-click —
 *  those would leave the backend's pairing loop running with no UI handle. */
export function PairingDialog({
  requestId,
  onCancel,
  cancelPending = false,
  cancelError,
}: PairingDialogProps) {
  const [copied, setCopied] = useState(false);
  useTimeout(() => setCopied(false), copied ? 2000 : null);

  const handleCopy = (): void => {
    if (!requestId) return;
    // Swallow rejection — requestId is still visible for manual selection.
    void navigator.clipboard.writeText(requestId).then(
      () => setCopied(true),
      () => {},
    );
  };

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        data-testid="gateway-pairing-dialog"
        className="sm:max-w-md"
      >
        <div className="flex flex-col items-center gap-4 py-2">
          <ShieldCheck className="size-10 text-primary" aria-hidden="true" />
          <div className="flex flex-col items-center gap-1">
            <DialogTitle>Pairing your device</DialogTitle>
            <DialogDescription>This usually takes a few seconds.</DialogDescription>
          </div>
          {/* Single atomic live region — when the gateway rotates the
           *  requestId mid-loop, screen readers re-announce the whole status
           *  rather than only the diff characters. */}
          <div
            className="flex flex-col items-center gap-3"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Waiting for approval…
            </div>
            <div
              className="flex items-center gap-1.5 text-xs text-muted-foreground/70"
              data-testid="gateway-pairing-request-id"
            >
              {requestId ? (
                <>
                  <span>Request ID:</span>
                  <code className="font-mono">{requestId}</code>
                </>
              ) : (
                <span>Connecting…</span>
              )}
            </div>
          </div>

          <Button
            variant="outline"
            onClick={onCancel}
            disabled={cancelPending}
            data-testid="gateway-pairing-cancel"
            className="w-full"
          >
            {cancelPending ? "Cancelling…" : "Cancel"}
          </Button>

          {cancelError ? (
            <p
              className="text-center text-xs text-destructive"
              role="alert"
              data-testid="gateway-pairing-cancel-error"
            >
              Couldn't cancel: {cancelError}
            </p>
          ) : null}

          {requestId ? (
            <InteractiveElementMonitor_Copy callback={handleCopy}>
              {(cb) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={cb}
                  aria-label={copied ? "Request ID copied" : "Copy request ID"}
                  data-testid="gateway-pairing-copy-request-id"
                  className="text-xs text-muted-foreground/70"
                >
                  {copied ? (
                    <>
                      <Check className="size-3" aria-hidden="true" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="size-3" aria-hidden="true" />
                      Copy request ID
                    </>
                  )}
                </Button>
              )}
            </InteractiveElementMonitor_Copy>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
