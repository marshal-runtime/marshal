/**
 * Provider-neutral bug-reporting seam.
 *
 * The investigation half of the bug reporter (diagnostics collection, hidden
 * AI session, report composition) knows nothing about where a report is
 * filed. A provider owns the destination: its availability probe, issue
 * creation, browser fallback, and the research affordances the investigation
 * is allowed to use.
 *
 * GitHub is one adapter (`github-provider.ts`); nothing outside that file
 * mentions `gh`, repos, or github.com.
 */

import type { PermissionsConfig } from "../../common/marshal-ipc-contract";

export interface IssueReport {
  title: string;
  body: string;
}

export interface IssueReporterAvailability {
  available: boolean;
  reason?: string;
}

/**
 * What the investigation half needs from a destination in order to research
 * the bug: prose instructions spliced into the prompt, plus the permission
 * scoping applied to the hidden session.
 */
export interface InvestigationProfile {
  instructions: string;
  permissions: PermissionsConfig;
}

export interface IssueReporterProvider {
  readonly id: string;
  /** Shown in the UI, e.g. "GitHub". */
  readonly displayName: string;
  /** Human-readable destination (e.g. "owner/repo"), or null when unconfigured. */
  getTarget(): string | null;
  checkAvailability(): Promise<IssueReporterAvailability>;
  /** Files the report and resolves with its URL. */
  createIssue(report: IssueReport): Promise<string>;
  /** Prefilled URL the user can finish by hand when {@link createIssue}
   *  fails. Null when the provider has no browser fallback. */
  buildFallbackUrl(report: IssueReport): string | null;
  /** Null when the provider offers no way for the AI to research the bug —
   *  the investigation then runs on diagnostics alone. */
  buildInvestigationProfile(): InvestigationProfile | null;
}
