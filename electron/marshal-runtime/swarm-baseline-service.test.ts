import type { SwarmRunTarget } from "@marshal/swarm";
import { describe, expect, it } from "vitest";

import { requireDeclaredTarget } from "./swarm-baseline-service";

const RUN_ID = "owner-1.20260826T000000000Z";
const MARSHAL_HEAD = "a".repeat(40);
const RUNTIME_HEAD = "b".repeat(40);

const TARGETS: readonly SwarmRunTarget[] = [
  { scope: "marshal-program", ref: "refs/heads/main", head: MARSHAL_HEAD },
  { scope: "runtime-program", ref: "refs/heads/main", head: RUNTIME_HEAD },
];

describe("declared swarm targets", () => {
  it("refuses a scope the run never declared", () => {
    const run = {
      runId: RUN_ID,
      state: "running" as const,
      objective: "Complete both programs",
      scope: "marshal-program",
      targets: TARGETS,
      tasks: [],
    };
    expect(() => requireDeclaredTarget(run, "foreign-program")).toThrow(
      'Task scope "foreign-program" is not one of the run\'s declared repository targets.',
    );
  });

  it("degrades a run recorded before targets existed to its single declared scope", () => {
    const legacy = {
      runId: RUN_ID,
      state: "running" as const,
      objective: "Complete the program",
      scope: "marshal-program",
      targetRef: "refs/heads/main",
      targetHead: MARSHAL_HEAD,
      tasks: [],
    };

    expect(requireDeclaredTarget(legacy, "marshal-program")).toEqual({
      scope: "marshal-program",
      ref: "refs/heads/main",
      head: MARSHAL_HEAD,
    });
    expect(() => requireDeclaredTarget(legacy, "runtime-program")).toThrow(
      'Task scope "runtime-program" is not one of the run\'s declared repository targets.',
    );
  });

  it("refuses a run that declares no repository target at all", () => {
    const untargeted = {
      runId: RUN_ID,
      state: "running" as const,
      objective: "Complete the program",
      scope: "marshal-program",
      tasks: [],
    };

    expect(() => requireDeclaredTarget(untargeted, "marshal-program")).toThrow(
      `Swarm run "${RUN_ID}" declares no repository targets.`,
    );
  });
});
