// A PermissionBroker for @marshal/runtime's portable RuntimeKernel that
// allows ONLY permissions present in an explicit declared set, denying
// everything else. This exists because the audit
// (AUDIT-VERDICT-AND-ACCEPTANCE.md, "What was actually tested before
// delivery") flags prior kernel-mock testing for using
// `createAllowAllPermissionBroker()` from @marshal/agent-runtime-core and
// then over-claiming policy coverage from it. D4's kernel-mock evidence must
// prove the declare -> grant / undeclared -> deny shape without an allow-all
// broker, while staying honest that this is NOT the real per-session
// PermissionPolicy (electron/permission-policy.ts) — see the `limits` field
// every kernel-mock receipt carries.
export function createDeclaredPermissionBroker(declaredPermissions) {
  const declared = new Set(declaredPermissions);
  return {
    decide(check) {
      const requirements = check.requirements ?? [];
      if (requirements.length === 0) return { decision: "allow" };
      const undeclared = requirements.find((requirement) => !declared.has(requirement.permission));
      if (undeclared) {
        return {
          decision: "deny",
          reason: `Permission not declared by the installed sample app: ${undeclared.permission}`,
        };
      }
      return {
        decision: "allow",
        grants: requirements.map((requirement) => requirement.permission),
      };
    },
  };
}
