import { Loader2 } from "@/components/icons";
import { useId, useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/marshal-ui/label";
import { Textarea } from "@/components/marshal-ui/textarea";
import { TelemetryPath_FeedbackDialog } from "@/services/telemetry/schema";

import type { UseAIInvestigatorResult } from "./useAIInvestigator";

const CONSENT_LABEL = "I understand my diagnostics log will be sent to the AI for analysis.";

interface AIInvestigatorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owned by the parent so the hook is instantiated exactly once. Avoids
   *  duplicate IPC subscriptions and a stale state mirror in the modal. */
  fb: UseAIInvestigatorResult;
}

export function AIInvestigatorModal({ open, onOpenChange, fb }: AIInvestigatorModalProps) {
  const [description, setDescription] = useState("");
  const [consent, setConsent] = useState(false);
  const consentId = useId();
  // The destination is surfaced via the main-process status snapshot
  // (`AIInvestigatorStatus.target`/`providerName`) — single source of truth,
  // no second config read in the renderer. We conditionally render the
  // destination sentence rather than synthesise a placeholder, since the
  // target is intentionally never given a default.
  const { target, providerName } = fb;

  // Reset the intake form on the rising edge of `open` (closed → open) while
  // idle. We can't rely on Radix `onOpenChange` for this — it only fires for
  // dialog-internal close (escape, backdrop), NOT when the parent
  // imperatively flips `open` to true via the trigger button. Without this
  // the previous run's text persists into the next intake.
  //
  // Uses React's "adjust state during render" pattern (see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // rather than a useEffect, which lint flags as a cascading render.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open && fb.state === "idle" && !fb.isStartPending) {
      setDescription("");
      setConsent(false);
    }
  }

  // Treat `isStartPending` as part of the investigation phase so the view
  // switches to the progress log the instant the user clicks Investigate —
  // not after the IPC roundtrip + first status event from main. On a cold
  // first run that gap can be several seconds (SDK + MCP warmup happen
  // inside createSession), and during it the user otherwise sees only the
  // intake form with a spinner on the button.
  const isInvestigating =
    fb.isStartPending || fb.state === "collecting" || fb.state === "investigating";
  const isReady = fb.state === "ready";
  const isPosting = fb.state === "posting" || fb.isPostPending;
  const isPosted = fb.state === "posted";
  const isError = fb.state === "error";

  const submitDisabled = !description.trim() || !consent || isInvestigating;

  async function onSubmit() {
    await fb.start({ userDescription: description.trim() });
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      onOpenChange(true);
      return;
    }
    // Closing the dialog never cancels — the manager keeps running. The user
    // must hit "Cancel investigation" explicitly.
    onOpenChange(false);
    if (isPosted || isError) {
      // After a terminal state, reset the manager so the next open starts clean.
      fb.reset();
    }
  }

  return (
    <TelemetryPath_FeedbackDialog>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg" data-testid="ai-investigator-modal">
          <DialogHeader>
            <DialogTitle>Report a bug</DialogTitle>
            <DialogDescription>
              We&apos;ll capture your diagnostics, ask the AI to pre-investigate, and let you file
              the issue with one click.
            </DialogDescription>
          </DialogHeader>

          {/* ── INTAKE ── */}
          {fb.state === "idle" && !fb.isStartPending && (
            <div className="flex flex-col gap-3" data-testid="ai-investigator-view-intake">
              <Label htmlFor="ai-investigator-description" className="text-sm font-medium">
                What went wrong?
              </Label>
              <Textarea
                id="ai-investigator-description"
                placeholder="One-line description of the issue"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                autoFocus
              />
              <Label
                htmlFor={consentId}
                className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground"
              >
                <Checkbox
                  id={consentId}
                  checked={consent}
                  onCheckedChange={(v) => setConsent(v === true)}
                />
                <span>{CONSENT_LABEL}</span>
              </Label>
              <DialogFooter>
                <Button variant="outline" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    void onSubmit();
                  }}
                  disabled={submitDisabled}
                >
                  Investigate
                </Button>
              </DialogFooter>
            </div>
          )}

          {/* ── INVESTIGATING ── */}
          {isInvestigating && (
            <div className="flex flex-col gap-3" data-testid="ai-investigator-view-investigating">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" />
                <span>Investigating… you can close this window; we&apos;ll keep working.</span>
              </div>
              <div
                className="max-h-64 overflow-auto rounded-sm border border-border bg-muted/40 p-2 font-mono text-xs"
                data-testid="ai-investigator-progress-log"
              >
                {fb.log.length === 0 ? (
                  <span className="text-muted-foreground">Starting…</span>
                ) : (
                  fb.log.map((entry) => (
                    <div key={`${entry.timestamp}-${entry.message}`}>{entry.message}</div>
                  ))
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => handleOpenChange(false)}>
                  Hide
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    void fb.cancel();
                  }}
                >
                  Cancel investigation
                </Button>
              </DialogFooter>
            </div>
          )}

          {/* ── READY / POSTING ── */}
          {(isReady || isPosting) && (
            <div className="flex flex-col gap-3" data-testid="ai-investigator-view-summary">
              {target && (
                <p className="text-xs text-muted-foreground">
                  The AI produced this report. It will be filed to <code>{target}</code> as-is.
                </p>
              )}
              <div className="rounded-sm border border-border bg-muted/30 p-2">
                <div className="text-sm font-semibold">{fb.title ?? "(no title)"}</div>
              </div>
              <pre
                className="max-h-72 overflow-auto rounded-sm border border-border bg-muted/30 p-2 font-mono text-xs whitespace-pre-wrap"
                data-testid="ai-investigator-summary-body"
              >
                {fb.body ?? ""}
              </pre>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                  disabled={fb.isPostPending}
                >
                  Close
                </Button>
                <Button
                  onClick={() => {
                    void fb.post();
                  }}
                  disabled={fb.isPostPending}
                >
                  {fb.isPostPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    `File to ${providerName ?? "the issue tracker"}`
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}

          {/* ── POSTED ── */}
          {isPosted && (
            <div className="flex flex-col gap-3" data-testid="ai-investigator-view-posted">
              <p className="text-sm">Thanks — your issue report has been filed.</p>
              {fb.issueUrl && (
                <a
                  href={fb.issueUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-primary underline"
                  onClick={(e) => {
                    // Route through shellAPI so the OS browser opens, not Electron's.
                    if (window.shellAPI?.openExternal) {
                      e.preventDefault();
                      void window.shellAPI.openExternal(fb.issueUrl!);
                    }
                  }}
                >
                  View issue
                </a>
              )}
              {fb.fallbackUrl && !fb.issueUrl && (
                <p className="text-xs text-muted-foreground">
                  The <code>gh</code> CLI wasn&apos;t available. We opened a prefilled GitHub issue
                  page in your browser — review and submit it there.
                </p>
              )}
              <DialogFooter>
                <Button onClick={() => handleOpenChange(false)}>Done</Button>
              </DialogFooter>
            </div>
          )}

          {/* ── ERROR ── */}
          {isError && (
            <div className="flex flex-col gap-3" data-testid="ai-investigator-view-error">
              <p className="text-sm text-destructive">
                Investigation failed: {fb.error ?? "Unknown error"}
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => handleOpenChange(false)}>
                  Close
                </Button>
                <Button
                  onClick={() => {
                    fb.reset();
                  }}
                >
                  Try again
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </TelemetryPath_FeedbackDialog>
  );
}
