import { describe, expect, it } from "vitest";

import { WorktreeCreationError } from "../worktree-creation-error";
import { classifySwarmLaunchFailure, isRetryableSwarmLaunchFailure } from "./swarm-launch-failure";

describe("classifySwarmLaunchFailure worktree failures", () => {
  it("treats capacity and transient worktree creation failures as retryable", () => {
    expect(
      classifySwarmLaunchFailure(
        new WorktreeCreationError("capacity", "ENOSPC", "no space left on device"),
      ),
    ).toEqual({
      kind: "retryable-worktree",
      retryable: true,
      category: "capacity",
      code: "ENOSPC",
      message: "no space left on device",
    });

    expect(
      classifySwarmLaunchFailure(
        new WorktreeCreationError("transient", "EBUSY", "index.lock: File exists"),
      ),
    ).toMatchObject({ kind: "retryable-worktree", retryable: true, code: "EBUSY" });
  });

  it("treats permission, conflict, and invalid-repository worktree failures as fatal", () => {
    for (const error of [
      new WorktreeCreationError("permission-denied", "EACCES", "permission denied"),
      new WorktreeCreationError("conflict", "EEXIST", "already checked out"),
      new WorktreeCreationError("invalid-repository", "ENOENT", "not a git repository"),
      new WorktreeCreationError("git-unavailable", "ENOENT", "could not find git"),
    ]) {
      expect(classifySwarmLaunchFailure(error)).toMatchObject({
        kind: "fatal",
        retryable: false,
      });
    }
  });

  it("finds a worktree creation failure nested in the cause chain", () => {
    const nested = new Error("Agent launch failed", {
      cause: new Error("worktree step failed", {
        cause: new WorktreeCreationError("transient", "EAGAIN", "resource temporarily unavailable"),
      }),
    });

    expect(classifySwarmLaunchFailure(nested)).toMatchObject({
      kind: "retryable-worktree",
      retryable: true,
      category: "transient",
      code: "EAGAIN",
      message: "Agent launch failed",
    });
  });

  it("classifies an unwrapped worktree error by its cause-chain errno", () => {
    const raw = Object.assign(new Error("git worktree add failed"), {
      cause: Object.assign(new Error("spawn failure"), { code: "ENOSPC" }),
    });

    expect(classifySwarmLaunchFailure(raw)).toMatchObject({
      kind: "retryable-worktree",
      retryable: true,
      category: "capacity",
      code: "ENOSPC",
    });
  });

  it("refuses to retry an environmental payload that already exhausted its attempts", () => {
    const exhausted = Object.assign(new Error("Worktree creation failed."), {
      payload: {
        kind: "environmental",
        category: "capacity",
        operation: "worktree.create",
        code: "ENOSPC",
        message: "Worktree creation failed.",
        retryable: false,
        attempts: 3,
      },
    });

    expect(classifySwarmLaunchFailure(exhausted)).toMatchObject({
      kind: "fatal",
      retryable: false,
      category: "capacity",
      code: "ENOSPC",
    });
  });
});

describe("classifySwarmLaunchFailure session-start failures", () => {
  it("treats transient session-start failures as retryable", () => {
    expect(
      classifySwarmLaunchFailure(new Error("Failed to start session: backend is not available")),
    ).toMatchObject({
      kind: "retryable-session-start",
      retryable: true,
      category: "session-start",
    });

    expect(
      classifySwarmLaunchFailure(
        Object.assign(new Error("session bootstrap"), { code: "ETIMEDOUT" }),
      ),
    ).toMatchObject({ kind: "retryable-session-start", retryable: true, code: "ETIMEDOUT" });

    expect(
      classifySwarmLaunchFailure(new Error("Copilot CLI exited unexpectedly during session start")),
    ).toMatchObject({ kind: "retryable-session-start", retryable: true });
  });

  it("treats structural session-start failures as fatal", () => {
    expect(
      classifySwarmLaunchFailure(new Error('Native agent "abc" was not found.')),
    ).toMatchObject({ kind: "fatal", retryable: false, category: "unknown" });

    expect(
      classifySwarmLaunchFailure(new TypeError('request.role has unsupported value "boss".')),
    ).toMatchObject({ kind: "fatal", retryable: false, category: "invalid-request" });
  });
});

describe("classifySwarmLaunchFailure terminal failures", () => {
  it("never retries abort, stopped, stale, or deleting failures", () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [abortError, "ABORTED"],
      [Object.assign(new Error("launch cancelled"), { code: "ABORT_ERR" }), "ABORTED"],
      [new Error("Native agent stopped waiting before completion."), "STOPPED"],
      [new Error("Swarm session handle is stale."), "STALE"],
      [new Error("Session is being deleted."), "DELETING"],
    ];

    for (const [error, code] of cases) {
      expect(classifySwarmLaunchFailure(error)).toMatchObject({
        kind: "fatal",
        retryable: false,
        category: "terminal",
        code,
      });
      expect(isRetryableSwarmLaunchFailure(error)).toBe(false);
    }
  });

  it("keeps terminal markers ahead of otherwise-retryable worktree failures", () => {
    const aborted = new WorktreeCreationError(
      "transient",
      "EBUSY",
      "worktree creation aborted by the caller",
    );

    expect(classifySwarmLaunchFailure(aborted)).toMatchObject({
      kind: "fatal",
      retryable: false,
      category: "terminal",
      code: "ABORTED",
    });
  });

  it("keeps terminal markers ahead of a retryable errno buried in the cause chain", () => {
    const stopped = new Error("Swarm run stopped", {
      cause: Object.assign(new Error("session start"), { code: "EBUSY" }),
    });

    expect(classifySwarmLaunchFailure(stopped)).toMatchObject({
      kind: "fatal",
      retryable: false,
      category: "terminal",
      code: "STOPPED",
    });
  });
});

describe("classifySwarmLaunchFailure fallbacks", () => {
  it("falls back to fatal for unrecognised values", () => {
    expect(classifySwarmLaunchFailure(undefined)).toEqual({
      kind: "fatal",
      retryable: false,
      category: "unknown",
      code: "UNKNOWN",
      message: "Unknown swarm launch failure",
    });

    expect(classifySwarmLaunchFailure("something went sideways")).toMatchObject({
      kind: "fatal",
      retryable: false,
      message: "something went sideways",
    });
  });
});
