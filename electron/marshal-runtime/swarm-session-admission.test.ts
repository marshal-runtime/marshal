import { describe, expect, it, vi } from "vitest";

import { WorktreeCreationError } from "../worktree-creation-error";
import {
  SWARM_SESSION_ADMISSION_DEFAULTS,
  SwarmSessionAdmission,
  type SwarmAdmissionDelayReason,
} from "./swarm-session-admission";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

interface RecordedDelay {
  readonly milliseconds: number;
  readonly reason: SwarmAdmissionDelayReason;
}

function recordingSleep(delays: RecordedDelay[]) {
  return async (
    milliseconds: number,
    reason: SwarmAdmissionDelayReason,
    signal?: AbortSignal,
  ): Promise<void> => {
    delays.push({ milliseconds, reason });
    if (signal?.aborted) throw signal.reason;
    await Promise.resolve();
  };
}

function flush(times = 8): Promise<void> {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index++) chain = chain.then(() => undefined);
  return chain;
}

describe("SwarmSessionAdmission defaults", () => {
  it("matches the bounded-start policy", () => {
    expect(SWARM_SESSION_ADMISSION_DEFAULTS).toEqual({
      maxConcurrentStarts: 4,
      startSpacingMs: 250,
      maxAttempts: 3,
      backoffMs: [1000, 3000],
      maxJitterMs: 500,
    });
    expect(new SwarmSessionAdmission().maxConcurrentStarts).toBe(4);
  });
});

describe("SwarmSessionAdmission queueing", () => {
  it("caps concurrent starts at four and admits queued launches in FIFO order", async () => {
    const delays: RecordedDelay[] = [];
    const admission = new SwarmSessionAdmission({ sleep: recordingSleep(delays) });
    const gates = Array.from({ length: 7 }, () => deferred<string>());
    const started: number[] = [];

    const runs = gates.map((gate, index) =>
      admission.run(async () => {
        started.push(index);
        return gate.promise;
      }),
    );

    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(admission.activeStarts).toBe(4);
    expect(admission.queuedStarts).toBe(3);

    gates[1].resolve("b");
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    gates[0].resolve("a");
    gates[2].resolve("c");
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);

    gates[3].resolve("d");
    gates[4].resolve("e");
    gates[5].resolve("f");
    gates[6].resolve("g");
    await expect(Promise.all(runs)).resolves.toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(admission.activeStarts).toBe(0);
    expect(admission.queuedStarts).toBe(0);
  });

  it("bounds starts, not running agents: slots free as soon as dispatch settles", async () => {
    const delays: RecordedDelay[] = [];
    const admission = new SwarmSessionAdmission({ sleep: recordingSleep(delays) });
    let liveAgents = 0;
    let concurrentStarts = 0;
    let peakConcurrentStarts = 0;

    const runs = Array.from({ length: 10 }, (_, index) =>
      admission.run(async () => {
        concurrentStarts++;
        peakConcurrentStarts = Math.max(peakConcurrentStarts, concurrentStarts);
        await Promise.resolve();
        concurrentStarts--;
        liveAgents++;
        return `agent-${index}`;
      }),
    );

    await expect(Promise.all(runs)).resolves.toHaveLength(10);
    expect(peakConcurrentStarts).toBeLessThanOrEqual(4);
    expect(liveAgents).toBe(10);
    expect(admission.activeStarts).toBe(0);
  });

  it("spaces admitted starts by 250 ms without spacing the first start", async () => {
    const delays: RecordedDelay[] = [];
    let clock = 0;
    const admission = new SwarmSessionAdmission({
      maxConcurrentStarts: 2,
      now: () => clock,
      sleep: recordingSleep(delays),
    });

    await admission.run(async () => "first");
    await admission.run(async () => "second");

    expect(delays).toEqual([{ milliseconds: 250, reason: "start-spacing" }]);

    clock = 10_000;
    await admission.run(async () => "third");
    expect(delays).toHaveLength(1);
  });
});

describe("SwarmSessionAdmission abort", () => {
  it("splices an aborted waiter out of the queue without consuming a slot", async () => {
    const delays: RecordedDelay[] = [];
    const admission = new SwarmSessionAdmission({
      maxConcurrentStarts: 1,
      sleep: recordingSleep(delays),
    });
    const holder = deferred<string>();
    const controller = new AbortController();
    const started: string[] = [];

    const running = admission.run(async () => {
      started.push("holder");
      return holder.promise;
    });
    await flush();

    const abandoned = admission.run(
      async () => {
        started.push("abandoned");
        return "abandoned";
      },
      { signal: controller.signal },
    );
    const survivor = admission.run(async () => {
      started.push("survivor");
      return "survivor";
    });
    await flush();
    expect(admission.queuedStarts).toBe(2);

    controller.abort(new Error("swarm run stopped"));
    await expect(abandoned).rejects.toThrow("swarm run stopped");
    expect(admission.queuedStarts).toBe(1);
    expect(admission.activeStarts).toBe(1);

    holder.resolve("holder");
    await expect(running).resolves.toBe("holder");
    await expect(survivor).resolves.toBe("survivor");
    expect(started).toEqual(["holder", "survivor"]);
    expect(admission.activeStarts).toBe(0);
  });

  it("aborts a pending retry backoff", async () => {
    const controller = new AbortController();
    const admission = new SwarmSessionAdmission({
      sleep: async (_milliseconds, _reason, signal) => {
        controller.abort(new Error("aborted during backoff"));
        if (signal?.aborted) throw signal.reason;
      },
    });
    const launch = vi.fn<(attempt: number) => Promise<string>>(async () => {
      throw new WorktreeCreationError("transient", "EBUSY", "index.lock file exists");
    });

    await expect(admission.run(launch, { signal: controller.signal })).rejects.toThrow(
      "aborted during backoff",
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(admission.activeStarts).toBe(0);
  });
});

describe("SwarmSessionAdmission retry", () => {
  it("retries retryable launches with 1 s/3 s backoff plus bounded jitter", async () => {
    const delays: RecordedDelay[] = [];
    const admission = new SwarmSessionAdmission({
      random: () => 0.5,
      sleep: recordingSleep(delays),
    });
    let attempts = 0;
    const observed: number[] = [];

    const result = await admission.run(
      async (attempt) => {
        attempts = attempt;
        if (attempt < 3) {
          throw new WorktreeCreationError("transient", "EBUSY", "index.lock file exists");
        }
        return "launched";
      },
      { onAttemptFailed: ({ backoffMs }) => observed.push(backoffMs) },
    );

    expect(result).toBe("launched");
    expect(attempts).toBe(3);
    expect(observed).toEqual([1250, 3250]);
    expect(delays.filter((delay) => delay.reason === "retry-backoff")).toEqual([
      { milliseconds: 1250, reason: "retry-backoff" },
      { milliseconds: 3250, reason: "retry-backoff" },
    ]);
    for (const [index, delay] of delays
      .filter((entry) => entry.reason === "retry-backoff")
      .entries()) {
      const base = [1000, 3000][index];
      expect(delay.milliseconds - base).toBeGreaterThanOrEqual(0);
      expect(delay.milliseconds - base).toBeLessThanOrEqual(500);
    }
  });

  it("keeps jitter within 500 ms for the maximum random draw", async () => {
    const delays: RecordedDelay[] = [];
    const admission = new SwarmSessionAdmission({ random: () => 1, sleep: recordingSleep(delays) });

    await expect(
      admission.run(async () => {
        throw new WorktreeCreationError("capacity", "ENOSPC", "no space left on device");
      }),
    ).rejects.toThrow("no space left on device");

    const backoffs = delays.filter((delay) => delay.reason === "retry-backoff");
    expect(backoffs.map((delay) => delay.milliseconds)).toEqual([1500, 3500]);
  });

  it("releases the slot before backoff so retries never hold the start cap", async () => {
    const slotSamples: number[] = [];
    const admission = new SwarmSessionAdmission({
      maxConcurrentStarts: 1,
      sleep: async (_milliseconds, reason) => {
        if (reason === "retry-backoff") slotSamples.push(admission.activeStarts);
        await Promise.resolve();
      },
    });

    await expect(
      admission.run(async () => {
        throw new WorktreeCreationError("transient", "EBUSY", "device or resource busy");
      }),
    ).rejects.toThrow("device or resource busy");

    expect(slotSamples).toEqual([0, 0]);
    expect(admission.activeStarts).toBe(0);
  });

  it("stops after three attempts and rethrows the original error", async () => {
    const delays: RecordedDelay[] = [];
    const admission = new SwarmSessionAdmission({ sleep: recordingSleep(delays) });
    const failure = new WorktreeCreationError("capacity", "ENOSPC", "no space left on device");
    const launch = vi.fn<(attempt: number) => Promise<string>>(async () => {
      throw failure;
    });

    await expect(admission.run(launch)).rejects.toBe(failure);
    expect(launch).toHaveBeenCalledTimes(3);
    expect(delays.filter((delay) => delay.reason === "retry-backoff")).toHaveLength(2);
  });

  it("never retries a fatal launch failure", async () => {
    const delays: RecordedDelay[] = [];
    const admission = new SwarmSessionAdmission({ sleep: recordingSleep(delays) });
    const launch = vi.fn<(attempt: number) => Promise<string>>(async () => {
      throw new WorktreeCreationError("permission-denied", "EACCES", "permission denied");
    });

    await expect(admission.run(launch)).rejects.toThrow("permission denied");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(delays.filter((delay) => delay.reason === "retry-backoff")).toHaveLength(0);
  });
});

describe("SwarmSessionAdmission runUnadmitted", () => {
  it("bypasses the queue, the cap, and start spacing while keeping retries", async () => {
    const delays: RecordedDelay[] = [];
    const admission = new SwarmSessionAdmission({
      maxConcurrentStarts: 1,
      sleep: recordingSleep(delays),
    });
    const holder = deferred<string>();

    const running = admission.run(async () => holder.promise);
    await flush();
    expect(admission.activeStarts).toBe(1);

    let attempts = 0;
    const bypass = await admission.runUnadmitted(async (attempt) => {
      attempts = attempt;
      if (attempt === 1) throw new WorktreeCreationError("transient", "EBUSY", "index.lock");
      return "bypassed";
    });

    expect(bypass).toBe("bypassed");
    expect(attempts).toBe(2);
    expect(admission.queuedStarts).toBe(0);
    expect(admission.activeStarts).toBe(1);
    expect(delays.filter((delay) => delay.reason === "start-spacing")).toHaveLength(0);

    holder.resolve("held");
    await expect(running).resolves.toBe("held");
  });
});
