import { describe, expect, it } from "vitest";

import { RECURSIVE_SWARM_STRATEGY_GUIDANCE } from "./swarm-system-message";

const guidance = RECURSIVE_SWARM_STRATEGY_GUIDANCE;

describe("recursive swarm system message", () => {
  it("makes the planner decide a cross-child boundary before delegating across it", () => {
    expect(guidance).toContain(
      "Decide every cross-child interface and invariant yourself before delegating implementation across it",
    );
    expect(guidance).toContain("record that decision in your owned topic file");
    expect(guidance).toContain("Plan and delegate; never implement");
  });

  it("keeps research children out of the shared design decision", () => {
    expect(guidance).toContain(
      "A research child returns ranked options, evidence, and a recommendation, optionally with a concise linked report artifact",
    );
    expect(guidance).toContain("The decision stays yours.");
  });

  it("gives exactly one owner the shared exported symbol", () => {
    expect(guidance).toContain(
      "assign one owner to land it before dependent work and require dependents to import it by name",
    );
    expect(guidance).toContain("no child may redefine, re-export, or re-declare the symbol");
  });

  it("assigns each remaining design question to at most one child planner", () => {
    expect(guidance).toContain("Give each remaining design question to at most one child planner.");
    expect(guidance).toContain("restate the parent decisions it inherits as immutable");
    expect(guidance).toContain(
      "coding stops at that boundary: the nearest common planner resolves the overlap",
    );
  });

  it("describes structured topic injection and root-only index ownership", () => {
    expect(guidance).toContain("one fenced block per topic file");
    expect(guidance).toContain("The root planner curates `index.md`");
    expect(guidance).toContain("single-writer property");
    expect(guidance).toContain(
      "If an assigned Field Guide file cannot be written, return the decision text and the exact failure in your result.",
    );
  });

  it("consumes the roster Swarm core derives instead of rebuilding one", () => {
    expect(guidance).toContain("The task prompt already lists your siblings and any outstanding");
    expect(guidance).toContain(
      "never rebuild it, persist your own copy, or add scheduling state to it",
    );
  });

  it("carries one short example of each correct delegation shape", () => {
    expect(guidance).toContain("Research only:");
    expect(guidance).toContain("shared service boundary in the pinned Swarm archive");
    expect(guidance).toContain("Return a plain blocker if the boundary task has not landed yet.");
    expect(guidance).toContain("Own the delegation transport domain end to end");
  });

  it("adds no fixed topology, ledger, or review score", () => {
    expect(guidance).toContain("There is no fixed fan-out, depth, stage sequence");
    expect(guidance).toContain("no decision IDs, locks, manifests, registries, or status entries");
    expect(guidance).toContain("invent a score or quorum");
    for (const forbidden of ["decision ledger", "status log", "quorum of", "review score"]) {
      expect(guidance).not.toContain(forbidden);
    }
  });
});
