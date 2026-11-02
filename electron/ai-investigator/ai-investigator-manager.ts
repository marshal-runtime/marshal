/**
 * AIInvestigatorManager — owns the lifecycle of a single AI bug
 * investigation. Singleton in the main process.
 *
 * Investigation is provider-neutral: this class collects diagnostics, runs a
 * hidden AI session and composes a report. Where that report is filed is
 * entirely owned by the injected {@link IssueReporterProvider} — GitHub is one
 * adapter (`electron/issue-reporter/github-provider.ts`).
 *
 * State machine:
 *   idle → collecting → investigating → ready → posting → posted | error
 *
 * Re-entering `start()` while a run is in flight is a no-op (returns the
 * current status). Closing the modal does NOT cancel — the user must call
 * `cancel()` explicitly.
 *
 * Permissions: registers a tight per-session policy (supplied by the provider)
 * on the hidden background session and sets deny-prompt so any non-allowlisted
 * tool call is auto-denied rather than hanging on a dialog the user will
 * never see.
 */

import type {
  AIInvestigatorEvent,
  AIInvestigatorProgressLogEntry,
  AIInvestigatorState,
  AIInvestigatorStatus,
} from "../../common/marshal-ipc-contract";
import { createLogger } from "../../common/marshal-logger";
import type { IssueReporterProvider } from "../issue-reporter/provider";
import { openExternalSafe } from "../open-external";
import type { PermissionPolicy } from "../permission-policy";
import { redactForDisplay, sanitizeForTelemetry } from "../marshal-value-sanitization";
import type { SessionManager } from "../sessions";
import {
  appendDiagnosticsToIssueBody,
  buildAIInvestigatorPrompt,
  composeInvestigatorReport,
} from "./ai-investigator-payload";

const log = createLogger("AIInvestigatorManager");

const AI_INVESTIGATOR_TIMEOUT_MS = 180_000;

export interface AIInvestigatorManagerDeps {
  sessionManager: SessionManager;
  permissionPolicy: PermissionPolicy;
  /** Destination adapter. Owns availability, issue creation and the research
   *  affordances the investigation is allowed to use. */
  issueReporter: IssueReporterProvider;
  /** Returns the tail of the diagnostics JSONL log (sanitized or raw — caller
   *  decides; the manager will sanitize before sending to the AI). */
  getDiagnosticsTail: () => Promise<string> | string;
  /** Optional emitter — wired in main.ts to forward to the renderer via
   *  `aiInvestigator:event`. Calling code can supply a no-op for tests. */
  emit: (event: AIInvestigatorEvent) => void;
}

export class AIInvestigatorManager {
  private state: AIInvestigatorState = "idle";
  private userDescription = "";
  private logEntries: AIInvestigatorProgressLogEntry[] = [];
  private title?: string;
  private body?: string;
  private issueUrl?: string;
  private fallbackUrl?: string;
  private errorMsg?: string;
  private sessionId: string | null = null;
  private aborted = false;
  /** Sanitized diagnostics tail captured at investigation time. Stashed so
   *  `post()` can append the same content the AI saw to the GitHub issue
   *  body inside a collapsible `<details>` block — without re-reading or
   *  re-sanitizing. Reset on every `start()`. */
  private pendingDiagnosticsTail = "";
  /** Monotonic per-run id. Bumped by each `start()`. `runInvestigation`
   *  bails after every async boundary if the current value differs from
   *  the one it captured at start, so a stale completion can't clobber
   *  the state of a newer run. */
  private runNonce = 0;

  /** Memoized availability probe. The probe may spawn subprocesses — we only
   *  want to do that once per process unless something explicitly resets it. */
  private availabilityPromise: Promise<{ available: boolean; reason?: string }> | null = null;

  constructor(private readonly deps: AIInvestigatorManagerDeps) {}

  /** Probe whether the user can report a bug at all — delegated in full to the
   *  configured destination provider. Memoized for the manager's lifetime. */
  async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
    this.availabilityPromise ??= this.runAvailabilityProbe();
    return this.availabilityPromise;
  }

  private async runAvailabilityProbe(): Promise<{ available: boolean; reason?: string }> {
    try {
      return await this.deps.issueReporter.checkAvailability();
    } catch (err) {
      log.warn("Issue reporter availability probe threw:", err);
      return { available: false, reason: String(err) };
    }
  }

  getStatus(): AIInvestigatorStatus {
    return {
      state: this.state,
      userDescription: this.userDescription,
      log: [...this.logEntries],
      title: this.title,
      body: this.body,
      issueUrl: this.issueUrl,
      fallbackUrl: this.fallbackUrl,
      error: this.errorMsg,
      target: this.deps.issueReporter.getTarget() ?? undefined,
      providerName: this.deps.issueReporter.displayName,
    };
  }

  async start(input: { userDescription: string }): Promise<void> {
    // Re-entry: if we're already mid-run, just resurface the existing state.
    if (this.state === "collecting" || this.state === "investigating" || this.state === "posting") {
      this.deps.emit({ type: "status", state: this.state });
      return;
    }

    // Reset state for a brand-new run.
    this.userDescription = input.userDescription.trim();
    this.logEntries = [];
    this.title = undefined;
    this.body = undefined;
    this.issueUrl = undefined;
    this.fallbackUrl = undefined;
    this.errorMsg = undefined;
    this.aborted = false;
    this.pendingDiagnosticsTail = "";
    const nonce = ++this.runNonce;
    this.transition("collecting");

    void this.runInvestigation(nonce).catch((err) => {
      // Stale completions land here too; ignore them.
      if (this.runNonce !== nonce) return;
      log.error("AI investigation failed:", err);
      this.errorMsg = String(err instanceof Error ? err.message : err);
      this.deps.emit({ type: "error", error: this.errorMsg });
      this.transition("error");
    });
  }

  async cancel(): Promise<void> {
    if (this.state !== "collecting" && this.state !== "investigating") return;
    this.aborted = true;
    // Bumping the nonce makes the in-flight runInvestigation's post-await
    // checks bail and prevents stale state writes if it completes after a
    // subsequent start().
    this.runNonce++;
    if (this.sessionId) {
      // Best-effort: abort the SDK session so sendAndCollect doesn't keep
      // running for the full AI_INVESTIGATOR_TIMEOUT_MS after the user cancels.
      try {
        await this.deps.sessionManager.abortSession(this.sessionId);
      } catch (err) {
        log.warn("Failed to abort ai-investigator session:", err);
      }
      this.cleanupSession();
    }
    this.errorMsg = "Cancelled by user";
    this.transition("error");
  }

  /** Return the manager to idle, clearing all run state.
   *  No-ops silently when a run is in flight — caller must `cancel()` first. */
  reset(): void {
    if (this.state === "collecting" || this.state === "investigating" || this.state === "posting") {
      return;
    }
    this.userDescription = "";
    this.logEntries = [];
    this.title = undefined;
    this.body = undefined;
    this.issueUrl = undefined;
    this.fallbackUrl = undefined;
    this.errorMsg = undefined;
    this.pendingDiagnosticsTail = "";
    this.aborted = false;
    this.availabilityPromise = null;
    this.runNonce++;
    this.transition("idle");
  }

  async post(): Promise<{
    success: boolean;
    url?: string;
    fallbackUrl?: string;
    error?: string;
  }> {
    if (this.state !== "ready") {
      return { success: false, error: `Cannot post in state "${this.state}"` };
    }
    if (!this.title || this.body === undefined) {
      return { success: false, error: "Missing title/body" };
    }


    this.transition("posting");
    const sanitizedTitle = sanitizeForTelemetry(this.title);
    // Body was already composed with redactForDisplay in runInvestigation —
    // use it directly. Then append the raw sanitized diagnostics tail inside
    // a collapsed <details> block so triagers always have the full log even
    // if the AI's curated excerpt is thin.
    const sanitizedBody = appendDiagnosticsToIssueBody(this.body, this.pendingDiagnosticsTail);
    const report = { title: sanitizedTitle, body: sanitizedBody };

    try {
      const { available } = await this.checkAvailability();
      if (available) {
        const url = await this.deps.issueReporter.createIssue(report);
        this.issueUrl = url;
        this.deps.emit({ type: "posted", issueUrl: url });
        this.transition("posted");
        return { success: true, url };
      }
    } catch (err) {
      log.warn("Issue creation failed, falling back to browser URL:", err);
      this.appendLog(`Filing the issue failed: ${String(err)}`);
    }

    // Fallback: prefilled new-issue URL via browser.
    const fallback = this.deps.issueReporter.buildFallbackUrl(report);
    if (!fallback) {
      this.errorMsg = "Could not file the report and this destination has no browser fallback.";
      this.deps.emit({ type: "error", error: this.errorMsg });
      this.transition("error");
      return { success: false, error: this.errorMsg };
    }
    this.fallbackUrl = fallback;
    openExternalSafe(fallback);
    this.deps.emit({ type: "posted", fallbackUrl: fallback });
    this.transition("posted");
    return { success: true, fallbackUrl: fallback };
  }

  // ── internals ──

  private async runInvestigation(nonce: number): Promise<void> {
    const profile = this.deps.issueReporter.buildInvestigationProfile();
    if (!profile) {
      throw new Error("No issue destination is configured");
    }

    // 1. Collect diagnostics (sanitize before they leave main).
    this.appendLog("Collecting diagnostics…");
    const diagRaw = await Promise.resolve(this.deps.getDiagnosticsTail());
    if (this.runNonce !== nonce) return;
    const diagnosticsTail = sanitizeForTelemetry(diagRaw);
    // Stash for post() — same content the AI saw, already sanitized.
    this.pendingDiagnosticsTail = diagnosticsTail;

    const sanitizedDescription = sanitizeForTelemetry(this.userDescription);
    const prompt = buildAIInvestigatorPrompt({
      userDescription: sanitizedDescription,
      diagnosticsTail,
      instructions: profile.instructions,
    });

    if (this.aborted || this.runNonce !== nonce) return;

    // 2. Spawn hidden session + tight permissions.
    this.appendLog("Creating investigation session…");
    const meta = await this.deps.sessionManager.createSession(undefined, undefined, {
      source: "feedback",
      setActive: false,
    });
    if (this.runNonce !== nonce) {
      // Stale run after our session was created — clean it up before bailing.
      try {
        await this.deps.sessionManager.deleteSession(meta.id, { cause: "investigator" });
      } catch (err) {
        log.warn("Failed to delete stale ai-investigator session:", err);
      }
      return;
    }
    this.sessionId = meta.id;
    this.deps.permissionPolicy.registerSessionPermissions(meta.id, profile.permissions);
    this.deps.permissionPolicy.setDenyPrompt(meta.id);

    if (this.aborted) {
      this.cleanupSession();
      return;
    }

    this.transition("investigating");
    this.appendLog("Investigating…");

    // 3. sendAndCollect with a streaming observer for progress. Cleanup MUST
    //    run on every exit path — including reject — so permissions and the
    //    ghost session are not leaked for the rest of the process lifetime.
    let result: Awaited<ReturnType<SessionManager["sendAndCollect"]>>;
    try {
      result = await this.deps.sessionManager.sendAndCollect(
        prompt,
        AI_INVESTIGATOR_TIMEOUT_MS,
        (event) => {
          if (this.aborted || this.runNonce !== nonce) return;
          if (event.type === "turn:tools-updated" && event.startedToolId) {
            const tool = event.toolCalls.find((t) => t.id === event.startedToolId);
            if (tool) this.appendLog(`Tool: ${tool.name}`);
          } else if (event.type === "turn:status" && event.status) {
            this.appendLog(event.status);
          }
        },
        meta.id,
      );
    } finally {
      this.cleanupSession();
    }
    if (this.aborted || this.runNonce !== nonce) return;

    // 4. Compose the report. Always-permissive: prefers the model's `# H1`
    //    when present, otherwise synthesizes a title from the user's own
    //    description so we never throw away a 2–3 minute investigation
    //    over a missing heading. The only remaining hard failure path is
    //    timeout with no text at all.
    if (result.kind === "timeout" && !result.text.trim()) {
      throw new Error("Investigation timed out before producing a report.");
    }
    const composed = composeInvestigatorReport(result.text, this.userDescription);
    if (composed.synthesized) {
      // Log a short, sanitized excerpt of the model output so future
      // regressions (prompt drift, skill load failure, etc.) are
      // diagnosable from marshal-diagnostics.jsonl without needing to
      // reproduce locally.
      const excerpt = sanitizeForTelemetry(result.text).slice(0, 500);
      log.warn("Investigator response missing # H1 — synthesized title from user description.", {
        excerpt,
      });
      this.appendLog(
        "Note: AI response did not include a structured title — synthesized one from your description.",
      );
    }

    // Sanitize once more before presenting — defence in depth (the AI could
    // have echoed something from disk that we want redacted in the issue).
    // Title uses sanitizeForTelemetry (truncate is fine for short titles);
    // body uses redactForDisplay so multi-KB structured reports aren't cut
    // off mid-sentence by the 4096-char telemetry cap.
    //
    // Prepend the user's original verbatim description as the first
    // section of the body. The AI report is the investigator's
    // interpretation; reviewers triaging the issue need the unfiltered
    // user voice up top so they can spot misinterpretations and quote
    // the user directly when asking follow-up questions.
    this.title = sanitizeForTelemetry(composed.title);
    const userVoice = redactForDisplay(this.userDescription).trim();
    const reportBody = redactForDisplay(composed.body);
    this.body = userVoice
      ? `## Original report\n\n> ${userVoice.replace(/\n/g, "\n> ")}\n\n---\n\n${reportBody}`
      : reportBody;
    this.deps.emit({ type: "ready", title: this.title, body: this.body });
    this.transition("ready");
  }

  private cleanupSession(): void {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    try {
      this.deps.permissionPolicy.unregisterSessionPermissions(sessionId);
      this.deps.permissionPolicy.clearDenyPrompt(sessionId);
    } catch (err) {
      log.warn("Failed to clean up ai-investigator session permissions:", err);
    }
    // Delete the ghost session from the index so it doesn't accumulate. Fire
    // and forget — failures here are not user-visible.
    void this.deps.sessionManager
      .deleteSession(sessionId, { cause: "investigator" })
      .catch((err) => {
        log.warn("Failed to delete ai-investigator session:", err);
      });
  }

  private transition(next: AIInvestigatorState): void {
    this.state = next;
    this.deps.emit({ type: "status", state: next });
  }

  private appendLog(message: string): void {
    const entry: AIInvestigatorProgressLogEntry = {
      timestamp: new Date().toISOString(),
      message,
    };
    this.logEntries.push(entry);
    // Trim to a reasonable cap — UI doesn't need thousands of lines.
    if (this.logEntries.length > 200) {
      this.logEntries = this.logEntries.slice(-200);
    }
    this.deps.emit({ type: "progress", message });
  }
}
