/-!
# Swarm journal reducer (marshal-swarm packages/swarm/src/contracts.ts)

`replaySwarmRun` folds the event journal; the file store replays before every
append, so an event is durable only if `step` accepts it (`none` = the reducer
throws). The model is generic over task ids and tree shape. Two guards are
over-approximated (planner artifact kinds; the single-root check), which only
makes the model accept MORE journals — every safety theorem below therefore
also holds for the real reducer. Payload-only events (execution receipts,
artifacts, reminders, child notifications, role models) never change task or
run state and are folded into `requireRunning` / `annotate`.
-/

namespace Marshal.Swarm

inductive TS | pending | running | blocked | completed | failed
  deriving DecidableEq, Repr

inductive RS | running | paused | completed | failed
  deriving DecidableEq, Repr

def RS.terminal (s : RS) : Prop := s = .completed ∨ s = .failed

instance (s : RS) : Decidable s.terminal := by unfold RS.terminal; infer_instance

/-- A task slot that holds no live work: absent, completed or failed. -/
def Settled (o : Option TS) : Prop := o = none ∨ o = some .completed ∨ o = some .failed

instance (o : Option TS) : Decidable (Settled o) := by unfold Settled; infer_instance

/-- Static shape derived from task ids: executor child ids are always
`${parentId}/${local}`, and "children must be terminal" is a prefix check. -/
structure Tree (Id : Type) where
  parentOf : Id → Option Id
  deps : Id → List Id
  descs : Id → List Id

structure Run (Id : Type) where
  state : RS
  task : Id → Option TS

inductive Ev (Id : Type)
  | paused | resumed | completed | failed | cancelled
  /-- run.systemFailureRecovered (tail/identity checks abstracted away) -/
  | recovered (root : Id)
  | added (t : Id)
  /-- task.dispatched and task.started -/
  | dispatched (t : Id)
  | taskCompleted (t : Id)
  /-- task.failed and task.cancelled -/
  | taskFailed (t : Id)
  | blocked (t : Id)
  | taskResumed (t : Id)
  /-- task.artifact / continuationRequested / reminded: task must be running -/
  | requireRunning (t : Id)
  /-- task.execution / continued / childrenNotified: task must exist -/
  | annotate (t : Id)

variable {Id : Type} [DecidableEq Id]

def Run.set (r : Run Id) (t : Id) (s : TS) : Run Id :=
  { r with task := fun x => if x = t then some s else r.task x }

def step (T : Tree Id) (r : Run Id) : Ev Id → Option (Run Id)
  | .paused => if r.state.terminal then none else some { r with state := .paused }
  | .resumed => if r.state.terminal then none else some { r with state := .running }
  | .completed => if r.state.terminal then none else some { r with state := .completed }
  | .failed => if r.state.terminal then none else some { r with state := .failed }
  | .cancelled => if r.state.terminal then none else some { r with state := .failed }
  | .recovered root =>
      if r.state = .failed ∧ T.parentOf root = none ∧ r.task root = some .failed then
        some { r.set root .running with state := .paused }
      else none
  | .added t =>
      if r.task t = none ∧ (∀ d ∈ T.deps t, r.task d ≠ none) ∧
          (∀ q, T.parentOf t = some q → r.task q = some .running) then
        some (r.set t .pending)
      else none
  | .dispatched t =>
      if r.task t = some .pending ∧ (∀ d ∈ T.deps t, r.task d = some .completed) ∧
          (∀ q, T.parentOf t = some q → r.task q ≠ some .completed ∧ r.task q ≠ some .failed) then
        some (r.set t .running)
      else none
  | .taskCompleted t =>
      if r.task t = some .running ∧ (∀ c ∈ T.descs t, Settled (r.task c)) then
        some (r.set t .completed)
      else none
  | .taskFailed t =>
      if Settled (r.task t) then none else some (r.set t .failed)
  | .blocked t => if r.task t = some .running then some (r.set t .blocked) else none
  | .taskResumed t => if r.task t = some .blocked then some (r.set t .running) else none
  | .requireRunning t => if r.task t = some .running then some r else none
  | .annotate t => if r.task t = none then none else some r

def replay (T : Tree Id) (r : Run Id) : List (Ev Id) → Option (Run Id)
  | [] => some r
  | e :: es => (step T r e).bind fun r' => replay T r' es

@[simp] theorem Run.set_task (r : Run Id) (t x : Id) (s : TS) :
    (r.set t s).task x = if x = t then some s else r.task x := rfl

@[simp] theorem Run.set_state (r : Run Id) (t : Id) (s : TS) : (r.set t s).state = r.state := rfl

set_option hygiene false in
/-- Split every `if` in `h : step … = some r'`, drop rejected branches, substitute. -/
macro "open_step" : tactic =>
  `(tactic| (simp only [step] at h; repeat' (split at h)) <;>
     simp only [reduceCtorEq, Option.some.injEq] at h <;> subst h)

/-! ## Finality of task and run states (single event) -/

theorem completed_task_final {T : Tree Id} {r r' : Run Id} {e : Ev Id} {x : Id}
    (h : step T r e = some r') (hx : r.task x = some .completed) :
    r'.task x = some .completed := by
  cases e <;> open_step <;> simp_all [Settled] <;> (intro hxt; subst hxt; simp_all)

/-- Failed is final, except the root's audited system-failure recovery. -/
theorem failed_task_final {T : Tree Id} {r r' : Run Id} {e : Ev Id} {x : Id}
    (h : step T r e = some r') (hx : r.task x = some .failed)
    (hchanged : r'.task x ≠ some .failed) :
    e = .recovered x ∧ r.state = .failed ∧ T.parentOf x = none := by
  cases e <;> open_step <;> simp_all [Settled] <;>
    (by_cases hxt : x = _ <;> simp_all [Settled])

theorem completed_run_final {T : Tree Id} {r r' : Run Id} {e : Ev Id}
    (h : step T r e = some r') (hs : r.state = .completed) : r'.state = .completed := by
  cases e <;> open_step <;> simp_all [RS.terminal]

/-! ## Journal guards (the store's last line of defence)

Both were gaps in the pinned pack 955bee3 and are enforced by the reducer now. -/

/-- A failed (incl. cancelled) run cannot be resumed; it re-enters only through
audited recovery, which leaves it paused. -/
theorem resume_after_failure_rejected (T : Tree Id) (r : Run Id) (hs : r.state = .failed) :
    step T r .resumed = none := by
  simp [step, hs, RS.terminal]

/-- Work is only dispatched while its parent can still consume the result. -/
theorem dispatch_requires_live_parent {T : Tree Id} {r r' : Run Id} {t q : Id}
    (h : step T r (.dispatched t) = some r') (hq : T.parentOf t = some q) :
    r.task q ≠ some .completed ∧ r.task q ≠ some .failed := by
  simp only [step] at h
  split at h
  · rename_i hg; exact hg.2.2 q hq
  · simp at h

/-- `run.completed` is accepted whatever the tasks' states; quiescence at run
completion comes from the executor's `finishRun` (root completed) plus
`subtree_quiescent_forever` below. -/
theorem run_completed_unguarded (T : Tree Id) (r : Run Id) (hs : r.state = .running) :
    step T r .completed = some { r with state := .completed } := by
  simp [step, hs, RS.terminal]

/-! ## Subtree quiescence (any tree, any journal length)

Well-formedness of executor-generated ids: every descendant has a parent, and
the parent of a descendant of `t` is `t` itself or another descendant of `t`. -/

structure WellFormed (T : Tree Id) : Prop where
  desc_has_parent : ∀ t c, c ∈ T.descs t → T.parentOf c ≠ none
  desc_closed : ∀ t c q, c ∈ T.descs t → T.parentOf c = some q → q = t ∨ q ∈ T.descs t

def Quiet (T : Tree Id) (r : Run Id) (t : Id) : Prop :=
  r.task t = some .completed ∧ ∀ c ∈ T.descs t, Settled (r.task c)

theorem quiet_step {T : Tree Id} (hwf : WellFormed T) {r r' : Run Id} {e : Ev Id} {t : Id}
    (h : step T r e = some r') (hq : Quiet T r t) : Quiet T r' t := by
  obtain ⟨ht, hd⟩ := hq
  refine ⟨completed_task_final h ht, fun c hc => ?_⟩
  have hc' := hd c hc
  cases e with
  | recovered root =>
      open_step
      rename_i hg
      have : c ≠ root := fun hcr => hwf.desc_has_parent t c hc (hcr ▸ hg.2.1)
      simpa [this] using hc'
  | added a =>
      open_step
      rename_i hg
      by_cases hca : c = a
      · subst hca
        obtain ⟨q, hq⟩ := Option.ne_none_iff_exists'.mp (hwf.desc_has_parent t c hc)
        have hrun := hg.2.2 q hq
        rcases hwf.desc_closed t c q hc hq with rfl | hqd
        · simp_all
        · have := hd q hqd; simp_all [Settled]
      · simpa [hca] using hc'
  | dispatched a =>
      open_step
      by_cases hca : c = a
      · subst hca; simp_all [Settled]
      · simpa [hca] using hc'
  | taskCompleted a =>
      open_step
      by_cases hca : c = a <;> simp_all [Settled]
  | taskFailed a =>
      open_step
      by_cases hca : c = a <;> simp_all [Settled]
  | blocked a =>
      open_step
      by_cases hca : c = a
      · subst hca; simp_all [Settled]
      · simpa [hca] using hc'
  | taskResumed a =>
      open_step
      by_cases hca : c = a
      · subst hca; simp_all [Settled]
      · simpa [hca] using hc'
  | _ => open_step <;> simpa using hc'

/-- **Once a task completes, nothing in its subtree is ever pending, running or
blocked again**, for every well-formed tree and every accepted journal suffix. -/
theorem subtree_quiescent_forever {T : Tree Id} (hwf : WellFormed T) :
    ∀ (es : List (Ev Id)) (r r' : Run Id) (t : Id),
      replay T r es = some r' → Quiet T r t → Quiet T r' t := by
  intro es
  induction es with
  | nil => intro r r' t h hq; simp [replay] at h; subst h; exact hq
  | cons e es ih =>
      intro r r' t h hq
      simp only [replay] at h
      cases hs : step T r e with
      | none => simp [hs] at h
      | some r1 =>
          simp only [hs, Option.bind_some] at h
          exact ih r1 r' t h (quiet_step hwf hs hq)

/-- Whole-run corollary: `finishRun` appends `run.completed` only when the root
completed; if every task with a parent descends from the root (true for
executor ids), no such task is ever live again, and the run stays completed. -/
theorem completed_run_quiescent_forever {T : Tree Id} (hwf : WellFormed T) (root : Id)
    (hall : ∀ c, T.parentOf c ≠ none → c ∈ T.descs root)
    (es : List (Ev Id)) (r r' : Run Id)
    (hq : Quiet T r root) (h : replay T r es = some r') :
    r'.task root = some .completed ∧ ∀ c, T.parentOf c ≠ none → Settled (r'.task c) := by
  obtain ⟨hr, hd⟩ := subtree_quiescent_forever hwf es r r' root h hq
  exact ⟨hr, fun c hc => hd c (hall c hc)⟩

/-! ## Non-vacuity: the TLA+ model's tree (SwarmRun.tla) is well-formed -/

inductive ModelTask | root | A | P | C
  deriving DecidableEq, Repr

def modelTree : Tree ModelTask where
  parentOf
    | .root => none
    | .A => some .root
    | .P => some .root
    | .C => some .P
  deps
    | .C => [.A]
    | _ => []
  descs
    | .root => [.A, .P, .C]
    | .P => [.C]
    | _ => []

theorem modelTree_wellFormed : WellFormed modelTree where
  desc_has_parent := by
    intro t c hc; cases t <;> cases c <;> simp_all [modelTree]
  desc_closed := by
    intro t c q hc hq; cases t <;> cases c <;> cases q <;> simp_all [modelTree]

end Marshal.Swarm
