// Marshal-owned module.
import fs from "node:fs/promises";
import path from "node:path";

import { Mutex } from "async-mutex";

import { resolveBase, statePath, statusPath, reviewsDir } from "./marshal-review-paths.ts";
import { renderStatusMd } from "./marshal-review-status-renderer.ts";
import { defaultState, StateSchema, type State } from "./marshal-review-types.ts";

export class StateStore {
  private state: State;
  private mutex = new Mutex();

  private constructor(initial: State) {
    this.state = initial;
  }

  static async create(): Promise<StateStore> {
    await fs.mkdir(resolveBase(), { recursive: true });
    await fs.mkdir(reviewsDir(), { recursive: true });

    // Clean up stale state.json.tmp.* files from a daemon that was killed
    // mid-rename. Otherwise these accumulate forever.
    await StateStore.cleanStaleTmps();

    let state: State;
    try {
      const raw = await fs.readFile(statePath(), "utf8");
      state = StateSchema.parse(JSON.parse(raw));
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") {
        state = defaultState();
        await StateStore.persist(state);
        await fs.writeFile(statusPath(), renderStatusMd(state), "utf8");
        return new StateStore(state);
      }
      throw err;
    }

    if (state.running.length > 0) {
      state = StateStore.recoverCrashed(state);
      await StateStore.persist(state);
    }
    await fs.writeFile(statusPath(), renderStatusMd(state), "utf8");
    return new StateStore(state);
  }

  private static async cleanStaleTmps(): Promise<void> {
    const dir = resolveBase();
    const stateBase = statePath().split(/[\\/]/).pop() ?? "state.json";
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    await Promise.allSettled(
      entries
        .filter((e) => e.startsWith(stateBase + ".tmp."))
        .map((e) => fs.unlink(path.join(dir, e))),
    );
  }

  /** Mark every running entry's PR row + latest iteration as crashed; clear running. */
  private static recoverCrashed(state: State): State {
    const next = structuredClone(state);
    for (const entry of next.running) {
      const row = next.prs[entry.prNumber];
      if (!row) continue;
      row.status = "crashed";
      const iter = row.iterations.at(-1);
      if (iter && iter.status === "running") {
        iter.status = "crashed";
        iter.failureReason = "daemon restart while iteration was running";
      }
    }
    next.running = [];
    return next;
  }

  /** Read-only snapshot. Mutating the returned object will NOT persist. */
  snapshot(): State {
    return structuredClone(this.state);
  }

  /** Apply a mutation under a serial lock. Validates schema before persisting. */
  async transaction(fn: (draft: State) => void | Promise<void>): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const draft = structuredClone(this.state);
      await fn(draft);
      const validated = StateSchema.parse(draft);
      await StateStore.persist(validated);
      await fs.writeFile(statusPath(), renderStatusMd(validated), "utf8");
      this.state = validated;
    });
  }

  private static async persist(state: State): Promise<void> {
    const tmp = `${statePath()}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tmp, statePath());
  }
}
