import MarshalFormal.Goal
import MarshalFormal.Swarm

/-! Every headline theorem depends only on Lean's standard axioms
(`propext`, `Classical.choice`, `Quot.sound`) — no `sorry`, no custom axioms.
`run.sh` fails if `sorryAx` or any other axiom appears here. -/

#print axioms Marshal.Goal.apply_status_change_bumps_epoch
#print axioms Marshal.Goal.apply_completion_requires_review
#print axioms Marshal.Goal.stale_fence_never_current
#print axioms Marshal.Goal.stale_review_never_applies
#print axioms Marshal.Goal.run_stopped
#print axioms Marshal.Swarm.completed_task_final
#print axioms Marshal.Swarm.failed_task_final
#print axioms Marshal.Swarm.completed_run_final
#print axioms Marshal.Swarm.subtree_quiescent_forever
#print axioms Marshal.Swarm.completed_run_quiescent_forever
#print axioms Marshal.Swarm.resume_after_failure_rejected
#print axioms Marshal.Swarm.dispatch_requires_live_parent
#print axioms Marshal.Swarm.run_completed_unguarded
#print axioms Marshal.Swarm.modelTree_wellFormed
