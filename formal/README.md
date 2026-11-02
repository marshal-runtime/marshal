# Formal verification: goals and swarm

TLA+ models (checked with TLC) and Lean 4 proofs of Marshal's autonomous-goal
engine and the `@marshal/swarm` run lifecycle. Every issue they found has been
fixed; regression tests for the fixes live next to the code they test.

```bash
formal/setup.sh          # once: JDK 21 + tla2tools.jar (~/.cache/marshal-formal) and Lean via elan
formal/run.sh            # everything (~40s); or: formal/run.sh tla | lean | repro
```

`run.sh` compares each check with its expected outcome and exits non-zero on
any mismatch. Each model has a `Fixed` constant. `Fixed = TRUE` is the current
code and every property must hold. `Fixed = FALSE` is the code before the
fixes, and TLC must still find a counterexample for each property there. That
proves the properties actually detect the bugs rather than holding vacuously.

## What is modelled

| Artifact                              | Code it models                                                                                                                                                         | Technique                                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tla/GoalEngine.tla`                  | `electron/goal/goal-engine.ts`, `goal-limits.ts`, `goal-manager.ts`, `electron/ipc/goal-ipc.ts`, SessionManager stop/runtime-switch, swarm controller adoption/handoff | TLC, all interleavings of user actions, reviewer verdicts/errors, turns, auth transitions, controller adoption; exhaustive at the configured bounds |
| `tla/SwarmRun.tla`                    | marshal-swarm `contracts.ts` (`replaySwarmRun`), `executor.ts`, `failure-cascade.ts`                                                                                   | TLC, exhaustive over a 4-task tree with nesting and a cross-branch dependency; one liveness property                                                |
| `lean/MarshalFormal/Goal.lean`        | every `GoalManager` mutation through `mutate`                                                                                                                          | Lean proofs for all goals and histories of any length                                                                                               |
| `lean/MarshalFormal/Swarm.lean`       | the journal reducer, generic over task ids and tree shape                                                                                                              | Lean proofs for every well-formed tree and journal of any length                                                                                    |
| `repro/swarm-lifecycle.repro.test.ts` | the installed `@marshal/swarm` runtime pack (host-17, commit `b820b89`)                                                                                                | vitest replays of the counterexamples; the fix checks fail on the host-16 pack                                                                      |

## Verified to hold

- Only an approved review of a `completed` proposal, raised under the current fence by the current run, completes a goal. The unreviewed fallbacks (review unavailable, hard limit) only ever block. (TLC + Lean)
- Every status change bumps the epoch. A fence that has gone stale can never become current again, so a stale review can never apply, for histories of any length. (Lean `stale_fence_never_current`, `stale_review_never_applies`)
- A stopped goal stays stopped under every mutation and history. (TLC + Lean)
- A live transition review is always the tracked pending review. No accepted proposal is silently lost, and no continuation turn starts while a live review runs. (TLC `LiveReviewTracked`, `NoOrphanedProposal`, `NoDispatchDuringLiveReview`)
- Continuations never exceed the hard ceiling, whatever the reviewer does. (TLC `ContinuationCapIsHard`)
- Swarm: completed tasks and completed runs are final. Failed tasks are final except the root's audited system-failure recovery. No task changes while a run is terminal. A terminal root always settles the run. (TLC + Lean)
- Swarm: a terminal run has no live tasks, except a failed run awaiting audited recovery. A failed task never has live work beneath it, and work is only dispatched under a live parent. (TLC `TerminalRunIsQuiescent`, `FailedSubtreeIsQuiescent`, `NoDispatchUnderDeadParent`; Lean `dispatch_requires_live_parent`)
- Swarm: once a task completes, nothing in its subtree is ever live again, for any tree and any journal. A failed run can't be resumed except through recovery. (Lean `subtree_quiescent_forever`, `completed_run_quiescent_forever`, `resume_after_failure_rejected`)

## Findings and fixes

1. **Goal engine: a stale review verdict cleared a newer pending review** (bug). `clearPendingReview(sessionId)` deleted whatever review was mapped. Trigger: a review is in flight, then `goal:set` (or `goal:pause` + `goal:resume`), then the agent proposes again, then the old verdict arrives. The new review then ran untracked: a second review and continuation turns could start alongside it. A parked proposal was dropped even though `propose()` had returned `true`.
   - **Fix:** `clearPendingReview(sessionId, pending)` only deletes its own entry, and a review withdrawn by pause/stop drops its verdict.
   - **Regression tests:** `electron/goal/goal-engine-review-identity.test.ts`.
2. **Goal engine: `MAX_CONTINUATIONS` / `MAX_ACTIVE_MS` were only soft.** Each reviewer rejection granted one more turn, without limit.
   - **Fix:** `goal-limits.ts` adds hard ceilings at twice the soft limits. At a ceiling the loop applies an unreviewed `blocked` state and exits.
   - **Regression tests:** same file.
3. **Swarm: a failed run could leave live tasks** (marshal-swarm).
   - **Fix:** a failed or cancelled task's live descendants are cancelled in the same journal write, and their delegations are cancelled too (`failure-cascade.ts`). `finishRun` cancels the remaining live tasks unless the root's recoverable owner-session transport failure is still the journal tail. Those children are kept for `recoverSystemFailure`.
4. **Swarm: work was dispatched under a failed planner** (marshal-swarm).
   - **Fix:** `executableSwarmTasks` skips tasks whose parent is not live. The reducer also refuses `task.dispatched` and `task.started` under a failed or completed parent.
5. **Swarm reducer accepted `run.resumed` after `run.failed` or `run.cancelled`** (marshal-swarm).
   - **Fix:** the reducer now refuses it for non-legacy journals. A failed run re-enters only through audited recovery.

Findings 3–5 have regression tests in marshal-swarm `packages/swarm/__tests__/failure-lifecycle.spec.ts`. Marshal installs them in the host-17 swarm pack (marshal-swarm `b820b89`), and `repro/swarm-lifecycle.repro.test.ts` checks the installed pack. The same file fails four of its five cases against the previous host-16 pack (the `run.completed` control passes on both).

## Modelling assumptions

- **One session.** Engine maps are keyed by session, so sessions don't interact.
- **Async boundaries.** Each `await` in the engine is a separate atomic step. `propose()` starts its review in the same step, because `runPendingReview` runs synchronously up to its first `await`. Timers and resume triggers are over-approximated as "may fire any time".
- **Swarm atomicity.** Each executor operation is one atomic append, guarded by the executor's own check and the reducer's. The file store replays the journal before every append, so only reducer-valid events are ever durable.
- **Bounds.** Goal models: 2 goals, 2 run identities, epoch ≤ 3, 2 review objects, soft cap 1 and hard cap 2 continuations. Lean removes all of these bounds for the fence, epoch and stopped properties.
- **Lean over-approximation.** The swarm reducer model accepts more journals than the real reducer (planner artifact kinds and the single-root check are omitted), so its safety theorems also hold for the real reducer. The executor's failure cascade is modelled in TLA+, not Lean.
- **Not modelled.** Prompt content, reviewer judgement quality, worktree/git integration, and the runtime's delegation scheduler beyond spawn, fail and cancel.
