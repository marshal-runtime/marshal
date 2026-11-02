----------------------------- MODULE GoalEngine -----------------------------
(***************************************************************************)
(* One session's goal record (electron/goal/goal-manager.ts) driven by the *)
(* GoalEngine (electron/goal/goal-engine.ts), the goal IPC handlers        *)
(* (electron/ipc/goal-ipc.ts), SessionManager stop/runtime-switch paths,   *)
(* and swarm controller adoption/handoff                                    *)
(* (electron/marshal-runtime/swarm-goal-handoff.ts).                       *)
(*                                                                         *)
(* Every awaited call in the engine is split into separate atomic steps,   *)
(* so TLC explores every interleaving of user actions, reviewer verdicts,  *)
(* continuation turns, auth transitions and controller adoption.           *)
(*                                                                         *)
(* The engine's pendingReviews map is keyed by session only; `pending` is  *)
(* that map entry and `flights` holds review objects whose reviewer call   *)
(* is still awaiting a verdict. A flight keeps running after its map entry *)
(* is cleared, exactly like the JS closure holding `pending`.              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS MaxGoals, RunIds, MaxEpoch, MaxCont, HardCont, MaxAttempts, MaxSysRej, MaxRid,
          Fixed  \* TRUE = current engine; FALSE = before the review-identity and hard-cap fixes

\* Goal ids are 1..MaxGoals and only ever increase, modelling fresh UUIDs;
\* 0 means "no goal yet". NoFence/NoReview are typed "absent" sentinels.
NoFence == <<0, 0>>
Targets == {"completed", "blocked", "paused"}
Statuses == {"pursuing", "paused", "blocked", "completed", "stopped"}

VARIABLES
  goalId,     \* session.goal.id (fresh ids), 0 before any goal exists
  epoch,      \* session.goal.epoch
  status,     \* session.goal.status
  contCount,  \* session.goal.continuationCount
  runId,      \* session.runtimeDelegationId (getRunIdentity)
  ctrl,       \* session.runtimeTaskController present (isControllerOwned)
  ready,      \* isDispatchReady (false during auth / inactive runtime)
  loopFence,  \* GoalEngine.running entry: fence of the active loop, or NoFence
  turn,       \* fence of the in-flight continuation turn, or NoFence
  pending,    \* GoalEngine.pendingReviews entry, or NoReview
  flights,    \* review objects whose reviewTransition() call is in flight
  allowance,  \* GoalEngine.reviewContinuationAllowances entry, or NoFence
  sysRej,     \* GoalEngine.systemRejections counter
  nextRid,    \* identity counter for review objects (ghost)
  accepted    \* ghost: proposals propose() returned true for, not yet resolved

vars == <<goalId, epoch, status, contCount, runId, ctrl, ready, loopFence, turn,
          pending, flights, allowance, sysRej, nextRid, accepted>>

Fence == <<goalId, epoch>>
HasGoal == goalId > 0
FenceCurrent(f) == HasGoal /\ f = Fence
Review(rid, f, t, run, sys, att, running) ==
  [rid |-> rid, fence |-> f, target |-> t, run |-> run, system |-> sys,
   attempts |-> att, running |-> running]
NoReview == Review(0, NoFence, "none", "none", FALSE, 0, FALSE)
HasPending == pending.rid > 0

TypeOK ==
  /\ goalId \in 0..MaxGoals
  /\ epoch \in Nat
  /\ status \in Statuses
  /\ runId \in RunIds
  /\ ctrl \in BOOLEAN /\ ready \in BOOLEAN
  /\ sysRej \in Nat /\ contCount \in Nat /\ nextRid \in Nat

-----------------------------------------------------------------------------
(* Engine helpers                                                          *)

\* GoalEngine.pause(): drop loop, pending review, allowance, rejection count.
\* cancelActiveTurn is async; the turn itself ends later via TurnEnd.
EnginePause ==
  /\ loopFence' = NoFence /\ pending' = NoReview /\ allowance' = NoFence /\ sysRej' = 0

\* GoalEngine.start(): only launches a loop for a pursuing, non-controller-
\* owned, dispatch-ready goal whose fence differs from the running loop.
StartLoop(gid, ep, st) ==
  IF gid > 0 /\ st = "pursuing" /\ ~ctrl /\ ready THEN <<gid, ep>>
  ELSE loopFence

Resolve(rid) == accepted' = {a \in accepted : a.rid # rid}

\* runPendingReview / isStaleRunProposal / applyUnreviewedSystemBlock call
\* clearPendingReview(sessionId, pending): the entry is deleted only if it is
\* still this review's object. Before the fix it deleted WHATEVER was mapped.
Tracked(f) == HasPending /\ pending.rid = f.rid
ClearFor(f) == IF Fixed /\ ~Tracked(f) THEN pending ELSE NoReview
\* A review pause/stop withdrew (no longer the map entry) drops its outcome.
Withdrawn(f) == Fixed /\ ~Tracked(f)
AtHardCap == Fixed /\ contCount >= HardCont

\* GoalEngine.propose(): fence current, status pursuing, no map entry. It
\* then calls runPendingReview synchronously; up to its first await that
\* sets `running = true` in the same tick unless dispatch is not ready
\* (parked until signalResumeTrigger).
NewReview(target, sys) == Review(nextRid, Fence, target, runId, sys, 0, ready)
Propose(target, sys) ==
  /\ HasGoal /\ status = "pursuing" /\ ~HasPending /\ nextRid <= MaxRid
  /\ pending' = NewReview(target, sys)
  /\ flights' = IF ready THEN flights \cup {NewReview(target, sys)} ELSE flights
  /\ nextRid' = nextRid + 1
  /\ accepted' = accepted \cup {[rid |-> nextRid, fence |-> Fence]}

-----------------------------------------------------------------------------
Init ==
  /\ goalId = 0 /\ epoch = 0 /\ status = "pursuing" /\ contCount = 0
  /\ runId \in RunIds /\ ctrl = FALSE /\ ready = TRUE
  /\ loopFence = NoFence /\ turn = NoFence /\ pending = NoReview /\ flights = {}
  /\ allowance = NoFence /\ sysRej = 0 /\ nextRid = 1 /\ accepted = {}

-----------------------------------------------------------------------------
(* User actions: goal IPC handlers and SessionManager paths                *)

\* goal:set -> engine.stop; replaceGoal (fresh id, initial epoch); engine.start
SetGoal(g) ==
  /\ g > goalId
  /\ goalId' = g /\ epoch' = 1 /\ status' = "pursuing" /\ contCount' = 0
  /\ pending' = NoReview /\ allowance' = NoFence /\ sysRej' = 0
  /\ loopFence' = StartLoop(g, 1, "pursuing")
  /\ UNCHANGED <<runId, ctrl, ready, turn, flights, nextRid, accepted>>

\* applyUserStatus: stopped is final; same status is a successful no-op.
UserStatus(target) ==
  /\ HasGoal /\ status # "stopped"
  /\ status' = target
  /\ epoch' = IF status = target THEN epoch ELSE epoch + 1

\* goal:pause -> manager.pause(fence); engine.pause
UserPause ==
  /\ UserStatus("paused") /\ EnginePause
  /\ UNCHANGED <<goalId, contCount, runId, ctrl, ready, turn, flights, nextRid, accepted>>

\* goal:stop -> manager.stop(fence); engine.stop
UserStop ==
  /\ UserStatus("stopped") /\ EnginePause
  /\ UNCHANGED <<goalId, contCount, runId, ctrl, ready, turn, flights, nextRid, accepted>>

\* goal:resume -> manager.resume(fence); engine.start
UserResume ==
  /\ UserStatus("pursuing")
  /\ loopFence' = StartLoop(goalId, epoch', "pursuing")
  /\ UNCHANGED <<goalId, contCount, runId, ctrl, ready, turn, pending, flights,
                 allowance, sysRej, nextRid, accepted>>

\* goal:steer -> epoch+1, re-pursue unless stopped; engine.start
\* goal:updateDefinition -> epoch+1, completed re-opens; engine.start
UserSteerOrRedefine(kind) ==
  /\ HasGoal
  /\ epoch' = epoch + 1
  /\ status' = CASE kind = "steer" /\ status # "stopped" -> "pursuing"
                 [] kind = "define" /\ status = "completed" -> "pursuing"
                 [] OTHER -> status
  /\ loopFence' = StartLoop(goalId, epoch + 1, status')
  /\ UNCHANGED <<goalId, contCount, runId, ctrl, ready, turn, pending, flights,
                 allowance, sysRej, nextRid, accepted>>

\* SessionManager.stopSession / pauseGoalsForRuntimeSwitch:
\* manager.pause() without a fence when pursuing, then engine.pause.
StopSession ==
  /\ HasGoal
  /\ IF status = "pursuing" THEN status' = "paused" /\ epoch' = epoch + 1
     ELSE UNCHANGED <<status, epoch>>
  /\ EnginePause
  /\ UNCHANGED <<goalId, contCount, runId, ctrl, ready, turn, flights, nextRid, accepted>>

-----------------------------------------------------------------------------
(* Environment: auth transitions, swarm controller adoption/release        *)

ToggleReady ==
  /\ ready' = ~ready
  /\ UNCHANGED <<goalId, epoch, status, contCount, runId, ctrl, loopFence, turn,
                 pending, flights, allowance, sysRej, nextRid, accepted>>

\* A (replacement) swarm run adopts the session: new delegation identity.
Adopt(d) ==
  /\ d # runId
  /\ runId' = d /\ ctrl' = TRUE
  /\ UNCHANGED <<goalId, epoch, status, contCount, ready, loopFence, turn,
                 pending, flights, allowance, sysRej, nextRid, accepted>>

\* releaseRuntimeTaskController keeps runtimeDelegationId, drops the flag.
Release ==
  /\ ctrl /\ ctrl' = FALSE
  /\ UNCHANGED <<goalId, epoch, status, contCount, runId, ready, loopFence, turn,
                 pending, flights, allowance, sysRej, nextRid, accepted>>

-----------------------------------------------------------------------------
(* Proposals                                                               *)

\* goalProposeTransition tool (any turn, current fence).
AgentPropose(t) ==
  /\ Propose(t, FALSE)
  /\ UNCHANGED <<goalId, epoch, status, contCount, runId, ctrl, ready, loopFence,
                 turn, allowance, sysRej>>

\* createSwarmTerminalGoalHandoff: controller-owned, failed run's delegation
\* equals the current one -> reviewed (non-system) blocked proposal.
SwarmHandoff ==
  /\ ctrl /\ Propose("blocked", FALSE)
  /\ UNCHANGED <<goalId, epoch, status, contCount, runId, ctrl, ready, loopFence,
                 turn, allowance, sysRej>>

-----------------------------------------------------------------------------
(* Engine loop (GoalEngine.loop)                                           *)

LoopActive ==
  /\ FenceCurrent(loopFence)
  /\ status = "pursuing" /\ ~ctrl /\ ready

\* engine.start()/signalResumeTrigger when no loop owns the current fence.
LoopStart ==
  /\ HasGoal /\ status = "pursuing" /\ ~ctrl /\ ready /\ loopFence # Fence
  /\ loopFence' = Fence
  /\ UNCHANGED <<goalId, epoch, status, contCount, runId, ctrl, ready, turn,
                 pending, flights, allowance, sysRej, nextRid, accepted>>

\* Loop observes a stale fence / status change / controller / not ready.
LoopExit ==
  /\ loopFence # NoFence /\ ~LoopActive
  /\ loopFence' = NoFence
  /\ UNCHANGED <<goalId, epoch, status, contCount, runId, ctrl, ready, turn,
                 pending, flights, allowance, sysRej, nextRid, accepted>>

\* Designed limit: continuationCount >= MAX_CONTINUATIONS without a
\* reviewer allowance -> proposeTransition (NOT a system proposal).
LoopLimit ==
  /\ LoopActive /\ turn = NoFence /\ ~AtHardCap
  /\ contCount >= MaxCont /\ allowance # Fence
  /\ Propose("blocked", FALSE)
  /\ UNCHANGED <<goalId, epoch, status, contCount, runId, ctrl, ready, loopFence,
                 turn, allowance, sysRej>>

\* stageContinuationDispatch + sendContinuation: loop waits while a review
\* is pending (pendingReviews.has) or the session is busy (turn in flight).
Dispatch ==
  /\ LoopActive /\ ~HasPending /\ turn = NoFence /\ ~AtHardCap
  /\ (contCount < MaxCont \/ allowance = Fence)
  /\ turn' = Fence
  /\ allowance' = IF allowance = Fence THEN NoFence ELSE allowance
  /\ UNCHANGED <<goalId, epoch, status, contCount, runId, ctrl, ready, loopFence,
                 pending, flights, sysRej, nextRid, accepted>>

\* goal-limits.ts hardLimitReason: at HARD_MAX_CONTINUATIONS the loop applies
\* an unreviewed `blocked` under its fence and exits (never `completed`).
LoopHardLimit ==
  /\ LoopActive /\ ~HasPending /\ turn = NoFence /\ AtHardCap
  /\ status' = "blocked" /\ epoch' = epoch + 1 /\ loopFence' = NoFence
  /\ UNCHANGED <<goalId, contCount, runId, ctrl, ready, turn, pending, flights,
                 allowance, sysRej, nextRid, accepted>>

\* Turn settles. finishContinuationTurn is fence-guarded and only reached
\* while the loop is still current. A failed turn may (after the consecutive
\* error budget) raise a system blocked proposal.
TurnEnd(failed) ==
  /\ turn # NoFence
  /\ turn' = NoFence
  /\ contCount' = IF ~failed /\ loopFence = turn /\ FenceCurrent(turn)
                  THEN contCount + 1 ELSE contCount
  /\ IF failed /\ LoopActive /\ loopFence = turn /\ HasGoal /\ status = "pursuing"
     THEN Propose("blocked", TRUE)
     ELSE UNCHANGED <<pending, flights, nextRid, accepted>>
  /\ UNCHANGED <<goalId, epoch, status, runId, ctrl, ready, loopFence,
                 allowance, sysRej>>

-----------------------------------------------------------------------------
(* Review (GoalEngine.runPendingReview)                                    *)

\* Entry: stale fence clears; not ready parks; non-pursuing clears; else the
\* reviewer call starts. Retry timers and signalResumeTrigger both re-enter
\* here, so it is enabled whenever the map entry is idle.
ReviewStart ==
  /\ HasPending /\ ~pending.running
  /\ ~FenceCurrent(pending.fence) \/ ready
  /\ IF ~FenceCurrent(pending.fence) \/ status # "pursuing"
     THEN pending' = NoReview /\ UNCHANGED flights
     ELSE /\ pending' = [pending EXCEPT !.running = TRUE]
          /\ flights' = flights \cup {[pending EXCEPT !.running = TRUE]}
  /\ UNCHANGED <<goalId, epoch, status, contCount, runId, ctrl, ready, loopFence,
                 turn, allowance, sysRej, nextRid, accepted>>

\* applyReviewedTransition: fence-guarded, requires pursuing.
CanApply(f) == FenceCurrent(f) /\ status = "pursuing"

\* applyUnreviewedSystemBlock(pending): isStaleRunProposal first (clears the
\* map entry), otherwise clear map entry and apply `blocked` (never
\* `completed`) under the review's fence.
SysBlock(f) ==
  /\ pending' = ClearFor(f) /\ sysRej' = 0
  /\ Resolve(f.rid)
  /\ IF f.run = runId /\ CanApply(f.fence)
     THEN /\ status' = "blocked" /\ epoch' = epoch + 1
          /\ loopFence' = IF loopFence = f.fence THEN NoFence ELSE loopFence
     ELSE UNCHANGED <<status, epoch, loopFence>>

\* Reviewer returned a verdict for flight f.
Verdict(f, approve) ==
  /\ f \in flights
  /\ flights' = flights \ {f}
  /\ IF Withdrawn(f)
     THEN /\ Resolve(f.rid)
          /\ UNCHANGED <<pending, status, epoch, loopFence, allowance, sysRej>>
     ELSE
     CASE ~FenceCurrent(f.fence) ->
            \* clearPendingReview(sessionId): clears WHATEVER entry is mapped.
            /\ pending' = ClearFor(f) /\ Resolve(f.rid)
            /\ UNCHANGED <<status, epoch, loopFence, allowance, sysRej>>
       [] f.run # runId ->
            \* isStaleRunProposal: replaced run's proposal is dropped.
            /\ pending' = ClearFor(f) /\ Resolve(f.rid)
            /\ UNCHANGED <<status, epoch, loopFence, allowance, sysRej>>
       [] approve ->
            /\ pending' = ClearFor(f) /\ Resolve(f.rid)
            /\ IF CanApply(f.fence)
               THEN /\ status' = f.target /\ epoch' = epoch + 1
                    /\ loopFence' = IF f.target = "completed" THEN loopFence ELSE NoFence
               ELSE UNCHANGED <<status, epoch, loopFence>>
            /\ UNCHANGED <<allowance, sysRej>>
       [] f.system /\ sysRej + 1 >= MaxSysRej ->
            /\ SysBlock(f)
            /\ UNCHANGED allowance
       [] OTHER ->
            \* reject: record, allowance, clear map entry, engine.start()
            /\ sysRej' = IF f.system THEN sysRej + 1 ELSE sysRej
            /\ allowance' = f.fence
            /\ pending' = ClearFor(f) /\ Resolve(f.rid)
            /\ loopFence' = StartLoop(goalId, epoch, status)
            /\ UNCHANGED <<status, epoch>>
  /\ UNCHANGED <<goalId, contCount, runId, ctrl, ready, turn, nextRid>>

\* Reviewer call threw (timeout, malformed verdict, transport).
ReviewError(f) ==
  /\ f \in flights
  /\ flights' = flights \ {f}
  /\ LET mapped == HasPending /\ pending.rid = f.rid
         att == f.attempts + 1
     IN IF Withdrawn(f)
        THEN /\ Resolve(f.rid)
             /\ UNCHANGED <<pending, status, epoch, loopFence, sysRej>>
        ELSE
        CASE ~FenceCurrent(f.fence) ->
               /\ pending' = ClearFor(f) /\ Resolve(f.rid)
               /\ UNCHANGED <<status, epoch, loopFence, sysRej>>
          [] ~ready ->
               \* parked: `pending.running = false` on the closure's object
               /\ pending' = IF mapped THEN [pending EXCEPT !.running = FALSE] ELSE pending
               /\ UNCHANGED <<status, epoch, loopFence, sysRej, accepted>>
          [] att >= MaxAttempts ->
               SysBlock(f)
          [] OTHER ->
               \* retry timer re-enters runPendingReview(sessionId), which
               \* reads the MAP entry, not this object.
               /\ pending' = IF mapped
                             THEN [pending EXCEPT !.running = FALSE, !.attempts = att]
                             ELSE pending
               /\ UNCHANGED <<status, epoch, loopFence, sysRej, accepted>>
  /\ UNCHANGED <<goalId, contCount, runId, ctrl, ready, turn, allowance, nextRid>>

-----------------------------------------------------------------------------
Next ==
  \/ \E g \in 1..MaxGoals : SetGoal(g)
  \/ UserPause \/ UserStop \/ UserResume \/ StopSession
  \/ UserSteerOrRedefine("steer") \/ UserSteerOrRedefine("define")
  \/ ToggleReady \/ Release \/ \E d \in RunIds : Adopt(d)
  \/ \E t \in Targets : AgentPropose(t)
  \/ SwarmHandoff
  \/ LoopStart \/ LoopExit \/ LoopLimit \/ LoopHardLimit \/ Dispatch
  \/ TurnEnd(TRUE) \/ TurnEnd(FALSE)
  \/ ReviewStart
  \/ \E f \in flights : Verdict(f, TRUE) \/ Verdict(f, FALSE) \/ ReviewError(f)

Spec == Init /\ [][Next]_vars

\* Keeps the state space finite; counters beyond these add no new behaviour.
Bounds == epoch <= MaxEpoch /\ contCount <= HardCont + 1

-----------------------------------------------------------------------------
(* Properties                                                              *)

LiveFlights == {f \in flights : FenceCurrent(f.fence)}

\* A proposal propose() accepted, whose fence is still current, is always
\* either the pending map entry or a reviewer call in flight. Violation =
\* the proposal is silently lost (no verdict will ever be applied).
NoOrphanedProposal ==
  \A a \in accepted :
    FenceCurrent(a.fence) =>
      \/ HasPending /\ pending.rid = a.rid
      \/ \E f \in flights : f.rid = a.rid

\* A live reviewer call is always the tracked map entry, so the loop's
\* "wait while pendingReviews.has()" gate and propose()'s single-review gate
\* both see it.
LiveReviewTracked ==
  \A f \in LiveFlights : HasPending /\ pending.rid = f.rid

\* A goal only becomes `completed` in the step where a reviewer call for a
\* `completed` proposal resolves, raised under the goal's current fence by
\* the current run. (The unreviewed system fallback only ever blocks.)
CompletionOnlyByApproval ==
  [][(status' = "completed" /\ ~(status = "completed" /\ goalId' = goalId))
       => \E f \in flights \ flights' :
            f.target = "completed" /\ f.fence = Fence /\ f.run = runId]_vars

\* A stopped goal never leaves `stopped` (only goal:set replaces it).
StoppedIsFinal ==
  [][(HasGoal /\ status = "stopped" /\ goalId' = goalId) => status' = "stopped"]_vars

\* Every status change of the same goal bumps the epoch (fences go stale).
StatusChangeBumpsEpoch ==
  [][(HasGoal /\ goalId' = goalId /\ status' # status) => epoch' > epoch]_vars

\* No continuation turn starts while a live transition review is running.
NoDispatchDuringLiveReview ==
  [][(turn = NoFence /\ turn' # NoFence) => LiveFlights = {}]_vars

\* Reviewer rejections may extend pursuit past MAX_CONTINUATIONS (MaxCont),
\* but never past HARD_MAX_CONTINUATIONS (HardCont).
ContinuationCapIsHard == contCount <= HardCont
=============================================================================
