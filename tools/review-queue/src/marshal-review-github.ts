// Marshal-owned module.
import { spawn } from "node:child_process";

export type PrState = "OPEN" | "MERGED" | "CLOSED";

export type PrStatus = {
  state: PrState;
  /** ISO timestamp of merge or close; null while the PR is still open. */
  closedAt: string | null;
};

/** Extract `owner/repo` from a github.com pull URL. Returns null on anything else,
 *  including malformed URLs and non-github hosts. */
export function parseRepoSlug(url: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** `gh pr view <n> --repo <slug> --json state,closedAt` returns lower-case
 *  field names; the API enum is upper-case. Normalize here. Exported for
 *  direct unit testing because the orchestrator integration tests mock
 *  `fetchPrStatus` with the already-uppercased shape, which would miss a
 *  regression in this function. */
export function normalizeState(raw: unknown): PrState | null {
  if (typeof raw !== "string") return null;
  const upper = raw.toUpperCase();
  return upper === "OPEN" || upper === "MERGED" || upper === "CLOSED" ? upper : null;
}

export type FetchPrStatus = (repo: string, prNumber: number) => Promise<PrStatus | null>;

/** Shell out to `gh pr view`. Returns null on any failure (auth, network,
 *  rate-limit, unknown PR) so the caller treats "couldn't verify" as
 *  "leave the row alone" rather than reaping unverified. */
export const fetchPrStatus: FetchPrStatus = (repo, prNumber) =>
  new Promise((resolve) => {
    const child = spawn(
      "gh",
      ["pr", "view", String(prNumber), "--repo", repo, "--json", "state,closedAt"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          resolve(null);
          return;
        }
        const state = "state" in parsed ? normalizeState(parsed.state) : null;
        if (!state) {
          resolve(null);
          return;
        }
        const closedAt =
          "closedAt" in parsed && typeof parsed.closedAt === "string" && parsed.closedAt
            ? parsed.closedAt
            : null;
        resolve({ state, closedAt });
      } catch {
        resolve(null);
      }
    });
  });
