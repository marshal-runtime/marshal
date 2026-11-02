------------------------------ MODULE SwarmRun ------------------------------
(***************************************************************************)
(* Durable lifecycle of one @marshal/swarm run (marshal-swarm              *)
(* packages/swarm/src: contracts.ts replaySwarmRun + executor.ts).         *)
(*                                                                         *)
(* The journal is event-sourced and the file store replays the whole log   *)
(* under a lock before every append, so an append lands only if the        *)
(* reducer accepts it. Each action below is one executor operation: its    *)
(* guard is the executor's own check AND the reducer's validation of the   *)
(* event(s) it appends. Agents, the runtime and the owner act in any order.*)
(*                                                                         *)
(* Fixed tree (covers nesting and a cross-branch dependency):              *)
(*   root (planner) -> A (worker), P (planner);  P -> C (worker, deps A)   *)
(***************************************************************************)
EXTENDS FiniteSets

CONSTANT Fixed  \* TRUE = current marshal-swarm; FALSE = pinned pack 955bee3 (before the fixes)

Tasks == {"root", "A", "P", "C"}
Parent == [t \in {"A", "P", "C"} |-> IF t = "C" THEN "P" ELSE "root"]
Role == [t \in Tasks |-> IF t \in {"root", "P"} THEN "planner" ELSE "worker"]
Deps == [t \in Tasks |-> IF t = "C" THEN {"A"} ELSE {}]
\* Reducer's "children must be terminal" uses taskId prefix `${taskId}/`,
\* i.e. every descendant; executor task ids are always parent-prefixed.
Desc == [t \in Tasks |-> CASE t = "root" -> {"A", "P", "C"}
                           [] t = "P" -> {"C"}
                           [] OTHER -> {}]

Terminal == {"completed", "failed"}
Live == {"pending", "running", "blocked"}

VARIABLES
  run,    \* SwarmRun.state: running | paused | completed | failed
  ts,     \* task state per task, "absent" until task.added
  art,    \* task has a completion-kind artifact (planners need one)
  tail    \* recovery tail: "other" | "rootTransportFail" | "recoverable"

vars == <<run, ts, art, tail>>

TypeOK ==
  /\ run \in {"running", "paused", "completed", "failed"}
  /\ ts \in [Tasks -> {"absent"} \cup Live \cup Terminal]
  /\ art \in [Tasks -> BOOLEAN]
  /\ tail \in {"other", "rootTransportFail", "recoverable"}

\* swarm.runs.create: run.created + task.added(root)
Init ==
  /\ run = "running"
  /\ ts = [t \in Tasks |-> IF t = "root" THEN "pending" ELSE "absent"]
  /\ art = [t \in Tasks |-> FALSE]
  /\ tail = "other"

SetTask(t, s) == ts' = [ts EXCEPT ![t] = s]
Running == run = "running"

\* failure-cascade.ts withFailureCascade: a failed task's live descendants are
\* cancelled in the same append, except under the root's recoverable
\* owner-session transport failure (kept for recoverSystemFailure).
FailWithCascade(t, keepChildren) ==
  ts' = [x \in Tasks |->
           IF x = t THEN "failed"
           ELSE IF Fixed /\ ~keepChildren /\ x \in Desc[t] /\ ts[x] \in Live THEN "failed"
           ELSE ts[x]]
ParentLive(t) ==
  IF ~Fixed \/ t = "root" THEN TRUE ELSE ts[Parent[t]] \in {"running", "blocked"}

-----------------------------------------------------------------------------
(* Driver (driveLoop / launch / recordOutcome)                             *)

\* reserveTaskDispatch under the state mutex: run running, task pending,
\* dependencies completed, parent still live (executableSwarmTasks +
\* reducer task.dispatched).
Dispatch(t) ==
  /\ Running /\ ts[t] = "pending"
  /\ \A d \in Deps[t] : ts[d] = "completed"
  /\ ParentLive(t)
  /\ SetTask(t, "running") /\ tail' = "other"
  /\ UNCHANGED <<run, art>>

\* driveLoop: pending task with a failed dependency -> task.failed
DependencyFail(t) ==
  /\ Running /\ ts[t] = "pending"
  /\ \E d \in Deps[t] : ts[d] = "failed"
  /\ FailWithCascade(t, FALSE) /\ tail' = "other"
  /\ UNCHANGED <<run, art>>

\* recordOutcome -> failTask (appendWhileRunning; the outcome check itself is
\* on an earlier snapshot, so any non-terminal state may be current).
\* `transport` = the owner-session busy/superseded error on the root.
RuntimeFail(t, transport) ==
  /\ Running /\ ts[t] \in Live
  /\ FailWithCascade(t, t = "root" /\ transport)
  /\ tail' = IF t = "root" /\ transport THEN "rootTransportFail" ELSE "other"
  /\ UNCHANGED <<run, art>>

\* recordOutcome: idle after two reminders -> task.blocked
\* (same event as the agent's swarm.nodes.block)
Block(t) ==
  /\ Running /\ ts[t] = "running"
  /\ SetTask(t, "blocked") /\ tail' = "other"
  /\ UNCHANGED <<run, art>>

\* finishRun (mutex): root completed -> run.completed; root failed -> run.failed,
\* preceded by task.cancelled for every live task unless the journal tail is
\* still the root's recoverable transport failure (rootFailureCancellations).
FinishRun ==
  /\ Running /\ ts["root"] \in Terminal
  /\ run' = ts["root"]
  /\ tail' = IF ts["root"] = "failed" /\ tail = "rootTransportFail"
             THEN "recoverable" ELSE "other"
  /\ ts' = IF Fixed /\ ts["root"] = "failed" /\ tail # "rootTransportFail"
           THEN [t \in Tasks |-> IF ts[t] \in Live THEN "failed" ELSE ts[t]]
           ELSE ts
  /\ UNCHANGED art

-----------------------------------------------------------------------------
(* Agent swarm.nodes operations (run must be running)                      *)

\* launch: running planner adds a child (reducer: parent running, deps exist)
Launch(t) ==
  /\ Running /\ t # "root" /\ ts[t] = "absent"
  /\ ts[Parent[t]] = "running" /\ Role[Parent[t]] = "planner"
  /\ \A d \in Deps[t] : ts[d] # "absent"
  /\ SetTask(t, "pending") /\ tail' = "other"
  /\ UNCHANGED <<run, art>>

PublishArtifact(t) ==
  /\ Running /\ ts[t] = "running" /\ ~art[t]
  /\ art' = [art EXCEPT ![t] = TRUE] /\ tail' = "other"
  /\ UNCHANGED <<run, ts>>

\* completeNode: running task, all descendants terminal, planner artifact
Complete(t) ==
  /\ Running /\ ts[t] = "running"
  /\ \A c \in Desc[t] : ts[c] \in Terminal \cup {"absent"}
  /\ Role[t] = "worker" \/ art[t]
  /\ SetTask(t, "completed") /\ tail' = "other"
  /\ UNCHANGED <<run, art>>

AgentFail(t) ==
  /\ Running /\ ts[t] = "running"
  /\ FailWithCascade(t, FALSE) /\ tail' = "other"
  /\ UNCHANGED <<run, art>>

\* swarm.nodes.resume by the task itself or its parent: blocked -> running
Unblock(t) ==
  /\ Running /\ ts[t] = "blocked"
  /\ SetTask(t, "running") /\ tail' = "other"
  /\ UNCHANGED <<run, art>>

-----------------------------------------------------------------------------
(* Root owner swarm.runs operations and environmental pauses                  *)

Pause ==
  /\ Running /\ run' = "paused" /\ tail' = "other"
  /\ UNCHANGED <<ts, art>>

\* executor.resume refuses terminal and running runs
ResumeRun ==
  /\ run = "paused" /\ run' = "running" /\ tail' = "other"
  /\ UNCHANGED <<ts, art>>

\* cancel: task.cancelled for every non-terminal task, then run.cancelled
Cancel ==
  /\ run \in {"running", "paused"}
  /\ ts' = [t \in Tasks |-> IF ts[t] \in Live THEN "failed" ELSE ts[t]]
  /\ run' = "failed" /\ tail' = "other"
  /\ UNCHANGED art

\* recoverSystemFailure: exact root transport-failure tail -> run paused,
\* root running again; an explicit resume is still required.
Recover ==
  /\ run = "failed" /\ ts["root"] = "failed" /\ tail = "recoverable"
  /\ run' = "paused" /\ SetTask("root", "running") /\ tail' = "other"
  /\ UNCHANGED art

-----------------------------------------------------------------------------
Next ==
  \/ \E t \in Tasks :
       \/ Dispatch(t) \/ DependencyFail(t) \/ Block(t) \/ Launch(t)
       \/ PublishArtifact(t) \/ Complete(t) \/ AgentFail(t) \/ Unblock(t)
       \/ RuntimeFail(t, TRUE) \/ RuntimeFail(t, FALSE)
  \/ FinishRun \/ Pause \/ ResumeRun \/ Cancel \/ Recover

Spec == Init /\ [][Next]_vars /\ WF_vars(FinishRun)

-----------------------------------------------------------------------------
(* Properties                                                              *)

\* A completed run has no live work left anywhere in the tree.
CompletedRunIsQuiescent ==
  run = "completed" => \A t \in Tasks : ts[t] \notin Live

\* Every terminal run has no live tasks left, except a failed run awaiting
\* audited recovery, whose children recovery resumes.
TerminalRunIsQuiescent ==
  (run \in {"completed", "failed"} /\ tail # "recoverable") => \A t \in Tasks : ts[t] \notin Live

\* A failed non-root task never has live work beneath it.
FailedSubtreeIsQuiescent ==
  \A t \in Tasks \ {"root"} : ts[t] = "failed" => \A c \in Desc[t] : ts[c] \notin Live

CompletedTaskIsFinal ==
  [][\A t \in Tasks : ts[t] = "completed" => ts'[t] = "completed"]_vars

\* Failed is final except the root's audited system-failure recovery.
FailedTaskIsFinal ==
  [][\A t \in Tasks :
       (ts[t] = "failed" /\ ts'[t] # "failed")
         => t = "root" /\ run = "failed" /\ run' = "paused" /\ tail = "recoverable"]_vars

CompletedRunIsFinal == [][run = "completed" => run' = "completed"]_vars

\* No task changes state while the run is terminal (only Recover exits).
TerminalRunIsFrozen ==
  [][(run \in {"completed", "failed"} /\ run' = run) => ts' = ts]_vars

\* Work is only dispatched under a live (running/blocked) parent.
NoDispatchUnderDeadParent ==
  [][\A t \in Tasks \ {"root"} :
       (ts[t] = "pending" /\ ts'[t] = "running") => ts[Parent[t]] \in {"running", "blocked"}]_vars

\* Once the root is terminal while running, the run settles.
RootOutcomeSettlesRun ==
  (Running /\ ts["root"] \in Terminal) ~> (run # "running")
=============================================================================
