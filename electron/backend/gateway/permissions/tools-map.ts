/**
 * m's `tools: Record<string, boolean>` ↔ marshal's `tools.allow / alsoAllow / deny`.
 *
 * Mapping rules (see spec §"Mapping algorithms"):
 *   true  → name in `alsoAllow`, removed from `deny`
 *   false → name in `deny`,      removed from `alsoAllow`
 *   absent in m map → name appears in neither marshal list
 *
 * `allow[]` (strict mode) is read as `true` for display but never written
 * to. If marshal config has `allow[]` set, `hasUnrepresentablePatterns`
 * returns true and the renderer routes the user to the raw JSON editor.
 */

export interface ToolPolicy {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
}

const GLOB_CHARS = /[*?]/;

export function toolPolicyToBooleans(policy: ToolPolicy): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const name of policy.allow ?? []) out[name] = true;
  for (const name of policy.alsoAllow ?? []) out[name] = true;
  for (const name of policy.deny ?? []) out[name] = false;
  return out;
}

export function mergeBooleansIntoToolPolicy(
  current: ToolPolicy,
  patch: Record<string, boolean>,
): ToolPolicy {
  const alsoAllow = new Set(current.alsoAllow ?? []);
  const deny = new Set(current.deny ?? []);

  for (const [name, enabled] of Object.entries(patch)) {
    if (enabled) {
      alsoAllow.add(name);
      deny.delete(name);
    } else {
      deny.add(name);
      alsoAllow.delete(name);
    }
  }

  return {
    ...(current.allow !== undefined ? { allow: current.allow } : {}),
    alsoAllow: [...alsoAllow],
    deny: [...deny],
  };
}

export function hasUnrepresentablePatterns(policy: ToolPolicy): boolean {
  if (policy.allow && policy.allow.length > 0) return true;
  for (const name of policy.alsoAllow ?? []) {
    if (GLOB_CHARS.test(name)) return true;
  }
  for (const name of policy.deny ?? []) {
    if (GLOB_CHARS.test(name)) return true;
  }
  return false;
}
