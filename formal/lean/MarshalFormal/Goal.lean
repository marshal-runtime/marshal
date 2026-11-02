/-!
# Goal record transitions (electron/goal/goal-manager.ts)

`GoalManager.mutate` loads the goal, rejects a stale `expectedFence`, runs one
update (which may throw `InvalidGoalTransitionError`) and persists. `apply`
below is that function for every mutating method; `none` is the `null` the
manager returns. TLC checks the concurrent engine for small bounds; these
theorems hold for every goal and every history of any length.
-/

namespace Marshal.Goal

inductive Status | pursuing | paused | blocked | completed | stopped
  deriving DecidableEq, Repr

/-- `GoalFence`: `{ goalId, epoch }`. -/
structure Fence where
  goalId : Nat
  epoch : Nat
  deriving DecidableEq, Repr

structure Goal where
  id : Nat
  epoch : Nat
  status : Status
  continuationCount : Nat
  deriving Repr

def Goal.fence (g : Goal) : Fence := ⟨g.id, g.epoch⟩

/-- `GoalTransitionProposal.target`. -/
inductive Target | completed | blocked | paused
  deriving DecidableEq, Repr

def Target.status : Target → Status
  | .completed => .completed
  | .blocked => .blocked
  | .paused => .paused

/-- The statuses `applyUserStatus` accepts (pause / resume / stop). -/
inductive UserStatus | pursuing | paused | stopped
  deriving DecidableEq, Repr

def UserStatus.status : UserStatus → Status
  | .pursuing => .pursuing
  | .paused => .paused
  | .stopped => .stopped

/-- Every GoalManager method that goes through `mutate`. -/
inductive Op
  | updateDefinition (expected : Option Fence)
  | updateContext (expected : Option Fence)
  | steer (expected : Option Fence)
  | userStatus (target : UserStatus) (expected : Option Fence)
  | applyReviewed (target : Target) (expected : Fence)
  | finishTurn (expected : Fence)

/-- `if (expectedFence && !matchesGoalFence(...)) return null`. -/
def fenceOk (g : Goal) : Option Fence → Prop
  | none => True
  | some f => g.fence = f

instance (g : Goal) (e : Option Fence) : Decidable (fenceOk g e) := by
  cases e <;> unfold fenceOk <;> infer_instance

def apply (g : Goal) : Op → Option Goal
  | .updateDefinition e =>
      if fenceOk g e then
        some { g with epoch := g.epoch + 1,
                      status := if g.status = .completed then .pursuing else g.status }
      else none
  | .updateContext e => if fenceOk g e then some g else none
  | .steer e =>
      if fenceOk g e then
        some { g with epoch := g.epoch + 1,
                      status := if g.status = .stopped then .stopped else .pursuing }
      else none
  | .userStatus s e =>
      if fenceOk g e then
        if g.status = .stopped ∧ s.status ≠ .stopped then none
        else if g.status = s.status then some g
        else some { g with status := s.status, epoch := g.epoch + 1 }
      else none
  | .applyReviewed t f =>
      if g.fence = f ∧ g.status = .pursuing then
        some { g with status := t.status, epoch := g.epoch + 1 }
      else none
  | .finishTurn f =>
      if g.fence = f then some { g with continuationCount := g.continuationCount + 1 }
      else none

/-! ## Single mutations -/

set_option hygiene false in
/-- Case-split every `if` in `h : apply … = some g'`, discard the `none`
branches and substitute the resulting goal. Core Lean only (no Mathlib). -/
macro "open_apply" : tactic =>
  `(tactic| (simp only [apply] at h; repeat' (split at h)) <;>
     simp only [reduceCtorEq, Option.some.injEq] at h <;> subst h)

theorem apply_id {g g' : Goal} {op : Op} (h : apply g op = some g') : g'.id = g.id := by
  cases op <;> open_apply <;> rfl

theorem apply_epoch_mono {g g' : Goal} {op : Op} (h : apply g op = some g') :
    g.epoch ≤ g'.epoch := by
  cases op <;> open_apply <;> simp

/-- Any status change bumps the epoch, so every fence captured before it goes stale. -/
theorem apply_status_change_bumps_epoch {g g' : Goal} {op : Op}
    (h : apply g op = some g') (hs : g'.status ≠ g.status) : g.epoch < g'.epoch := by
  cases op <;> open_apply <;> simp_all

/-- A stopped goal stays stopped under every mutation (only `replaceGoal` mints a new one). -/
theorem apply_stopped_absorbing {g g' : Goal} {op : Op}
    (h : apply g op = some g') (hs : g.status = .stopped) : g'.status = .stopped := by
  cases op <;> open_apply <;> simp_all

/-- The only way into `completed` is an approved review of a `completed` proposal
raised under the goal's current fence while it was pursuing. -/
theorem apply_completion_requires_review {g g' : Goal} {op : Op}
    (h : apply g op = some g') (hbefore : g.status ≠ .completed)
    (hafter : g'.status = .completed) :
    op = .applyReviewed .completed g.fence ∧ g.status = .pursuing := by
  cases op with
  | applyReviewed t f =>
      open_apply
      rename_i hc
      cases t <;> simp_all [Target.status]
  | userStatus s e =>
      open_apply <;> cases s <;> simp_all [UserStatus.status]
  | _ => open_apply <;> simp_all

/-- A reviewed transition only lands under the exact current fence. -/
theorem apply_reviewed_requires_current_fence {g g' : Goal} {t : Target} {f : Fence}
    (h : apply g (.applyReviewed t f) = some g') : f = g.fence := by
  simp only [apply] at h
  split at h
  · rename_i hc; exact hc.1.symm
  · simp at h

/-! ## Histories

A rejected mutation (`null`) leaves the persisted goal untouched. -/

def step (g : Goal) (op : Op) : Goal := (apply g op).getD g

def run (g : Goal) (ops : List Op) : Goal := ops.foldl step g

theorem step_id (g : Goal) (op : Op) : (step g op).id = g.id := by
  unfold step
  cases h : apply g op with
  | none => rfl
  | some g' => simp [apply_id h]

theorem step_epoch_mono (g : Goal) (op : Op) : g.epoch ≤ (step g op).epoch := by
  unfold step
  cases h : apply g op with
  | none => simp
  | some g' => simpa using apply_epoch_mono h

theorem run_id (g : Goal) (ops : List Op) : (run g ops).id = g.id := by
  induction ops generalizing g with
  | nil => rfl
  | cons op ops ih => simp only [run, List.foldl] at *; rw [ih, step_id]

theorem run_epoch_mono (g : Goal) (ops : List Op) : g.epoch ≤ (run g ops).epoch := by
  induction ops generalizing g with
  | nil => simp [run]
  | cons op ops ih =>
      simp only [run, List.foldl] at *
      exact Nat.le_trans (step_epoch_mono g op) (ih (step g op))

theorem run_append (g : Goal) (xs ys : List Op) : run g (xs ++ ys) = run (run g xs) ys := by
  simp [run, List.foldl_append]

/-- **Fence safety.** Once any mutation has bumped the epoch, the old fence can
never become current again, however many further mutations follow. -/
theorem stale_fence_never_current (g : Goal) (xs ys : List Op)
    (hbumped : g.epoch < (run g xs).epoch) : (run g (xs ++ ys)).fence ≠ g.fence := by
  intro heq
  have hmono := run_epoch_mono (run g xs) ys
  rw [← run_append] at hmono
  have : (run g (xs ++ ys)).epoch = g.epoch := by
    simpa [Goal.fence] using congrArg Fence.epoch heq
  omega

/-- Consequence: a review proposed under a fence that has since gone stale is
rejected by `applyReviewedTransition` forever after. -/
theorem stale_review_never_applies (g : Goal) (xs ys : List Op) (t : Target)
    (hbumped : g.epoch < (run g xs).epoch) :
    apply (run g (xs ++ ys)) (.applyReviewed t g.fence) = none := by
  cases h : apply (run g (xs ++ ys)) (.applyReviewed t g.fence) with
  | none => rfl
  | some g' =>
      exact absurd (apply_reviewed_requires_current_fence h).symm
        (stale_fence_never_current g xs ys hbumped)

theorem step_stopped (g : Goal) (op : Op) (hs : g.status = .stopped) :
    (step g op).status = .stopped := by
  unfold step
  cases h : apply g op with
  | none => simpa using hs
  | some g' => simpa using apply_stopped_absorbing h hs

/-- A stopped goal is stopped after any history. -/
theorem run_stopped (g : Goal) (ops : List Op) (hs : g.status = .stopped) :
    (run g ops).status = .stopped := by
  induction ops generalizing g with
  | nil => simpa [run] using hs
  | cons op ops ih =>
      simp only [run, List.foldl] at *
      exact ih (step g op) (step_stopped g op hs)

end Marshal.Goal
