---
name: codebase-health
description: Produce a codebase health report combining fallow health (complexity + dead code + duplication), pnpm audit (security advisories), and pnpm outdated (dependency currency). Computes an adjusted score and surfaces top hotspots. Use when the user asks to "check repo health", "audit the codebase", "how healthy is the code", or wants a periodic health check.
allowed-tools:
  - Bash(pnpm exec fallow *)
  - Bash(pnpm audit *)
  - Bash(pnpm outdated *)
  - Bash(node -e *)
  - Read
---

# Codebase Health Skill

Produce a single health snapshot of the repo by combining three signals:

1. **`fallow health`** — complexity, dead code, duplication, hotspots (static + git-aware).
2. **`pnpm audit`** — open security advisories on resolved dependencies.
3. **`pnpm outdated`** — how far the dependency tree has drifted from latest.

Output a single number (0–100) plus a ranked list of what hurts it most, plus drill-down commands the user can run if they want details.

## Prerequisites

All JavaScript dependencies resolve from public npm. A 401/403 during `pnpm outdated` or `pnpm audit` indicates a local npm configuration problem rather than a required Marshal feed.

`fallow` reads `.fallowrc.json` at repo root for the false-positive allowlist (runtime-spawned MCP packages, oxlint jsPlugins referenced by string, telemetry barrel re-exports). Don't bypass the config — if a finding looks like a false positive, add it to `.fallowrc.json` instead of ignoring the output.

## Commands to run, in order

```bash
# 1. Complexity + dead code + duplication (runs all three analyses, surfaces
#    aggregate scores and complexity findings; see drill-downs below for details).
pnpm exec fallow health --format json > /tmp/health.json

# 2. Security advisories. --prod limits to runtime deps; drop --prod for full audit.
pnpm audit --prod --json > /tmp/audit.json 2>/dev/null || true

# 3. Dependency drift.
pnpm outdated --format json > /tmp/outdated.json 2>/dev/null || true
```

`pnpm audit` and `pnpm outdated` both exit non-zero when they find anything — that's expected, don't treat it as a failure. The `|| true` keeps the pipeline moving.

## Reading the output

### fallow health

Key fields in `/tmp/health.json`:

- `health_score.score` (0–100) and `health_score.grade` (A–F) — the base number.
- `health_score.penalties` — per-category point deductions. Useful to see what dragged the score down.
- `vital_signs.dead_file_pct`, `dead_export_pct`, `duplication_pct`, `unused_dep_count`, `avg_cyclomatic`, `p90_cyclomatic` — headline ratios.
- `hotspots` — sorted by `score = churn × complexity × fan_in`. Take the top 10.
- `findings` — functions above complexity thresholds (cyclomatic, cognitive, CRAP). Sort by `crap` desc, take the top 10.
- `large_functions` — sorted by `line_count`. Take the top 5.

### pnpm audit

`/tmp/audit.json` shape: `{ "advisories": { "<id>": { "severity": "...", "module_name": "...", ... } }, "metadata": { "vulnerabilities": { "critical": N, "high": N, "moderate": N, "low": N, "info": N } } }`.

Count each severity bucket. Example:

```bash
node -e "const j=JSON.parse(require('fs').readFileSync('/tmp/audit.json','utf8')); console.log(j.metadata?.vulnerabilities || {});"
```

### pnpm outdated

`/tmp/outdated.json` is a map of `{ <package>: { current, wanted, latest, dependencyType, ... } }`. Classify each entry:

- **Major behind**: `latest` major > `current` major.
- **Minor behind**: same major, `latest` minor > `current` minor.
- **Patch behind**: same major+minor, `latest` patch > `current` patch (usually safe to ignore in the score).

```bash
node -e "
const j = JSON.parse(require('fs').readFileSync('/tmp/outdated.json','utf8'));
const sv = s => s.replace(/^[\\^~]/, '').split('.').map(Number);
let major=0, minor=0, patch=0;
for (const [name, info] of Object.entries(j)) {
  const [cM,cm,cp] = sv(info.current);
  const [lM,lm,lp] = sv(info.latest);
  if (lM > cM) major++;
  else if (lm > cm) minor++;
  else if (lp > cp) patch++;
}
console.log({major, minor, patch, total: Object.keys(j).length});
"
```

## Adjusted score formula

Start with `fallow_score`, then subtract:

| Signal             | Per finding | Cap       |
| ------------------ | ----------- | --------- |
| Security: critical | −10         | —         |
| Security: high     | −5          | −25 total |
| Security: moderate | −2          | −10 total |
| Security: low      | −0.5        | −5 total  |
| Outdated: major    | −1          | −15 total |
| Outdated: minor    | −0.2        | −5 total  |
| Outdated: patch    | —           | ignored   |

Clamp the final score to `[0, 100]`. Keep one decimal. Re-derive a letter grade: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, else F. Note: grade boundaries here are tighter than fallow's internal ones because we're combining three signals.

Worked example (numbers from current repo state with `.fallowrc.json` loaded, April 2026):

- fallow_score = 90.5
- Security: 0 critical, 0 high, 7 moderate → 7 × −2 = −14, capped at −10
- Outdated: 1 major, 13 minor, 21 patch → −1 + −2.6 = −3.6
- Adjusted = 90.5 − 10 − 3.6 = **76.9 (C)**

If the adjusted score is meaningfully lower than the fallow score, say so explicitly — "fallow rates the code at A, but security advisories and dep drift drag it to C." That gap is the insight; the absolute number isn't.

## Output shape

Report in this order. Keep it tight — the user should be able to skim in under 30 seconds.

1. **Headline**: adjusted score + grade, with the fallow-only score in parens. One sentence explaining the biggest drag.
2. **Penalty breakdown**: table of the four signals (fallow, security, outdated, total).
3. **Top 5 hotspots** from fallow health (file, churn, fan-in, trend).
4. **Top 5 complex functions** from fallow health findings, sorted by CRAP.
5. **Security advisories**: list each critical/high with package name and fix path. Skip moderate/low unless the user asks.
6. **Major-version-behind deps**: list all, grouped by dependencyType (prod vs dev). Skip minor/patch unless the user asks.
7. **Drill-down commands** (copy-pasteable):
   - `pnpm exec fallow dead-code` — full list of unused files/exports/types/class members.
   - `pnpm exec fallow dupes` — duplicate code clone groups and families.
   - `pnpm exec fallow health --format human` — complexity-focused human-readable report.
   - `pnpm exec fallow trace <file>:<export>` — why a specific export is considered used or unused.
   - `pnpm exec fallow trace-dependency <pkg>` — every import of a package.
   - `pnpm exec fallow fix --dry-run` — preview auto-removal of unused exports/deps/enum members.
   - `pnpm audit --audit-level=high` — security only, narrowed to high/critical.
   - `pnpm outdated --long` — include dependency type and homepage URLs.

## False-positive escape hatches

If the report flags something that's a false positive, update `.fallowrc.json` rather than filtering in the skill:

- Runtime-spawned package or CLI-only tool → add to `ignoreDependencies`.
- Intentional public API surface (e.g., telemetry barrel re-exports) → add to `ignoreExports` with `{ file: "glob/**", exports: ["*"] }`.
- Generated or vendored code → add to `ignorePatterns`.

Use `pnpm exec fallow trace-dependency <pkg>` first to confirm it's truly a false positive before editing the config.

## When not to use this skill

- Use `/marshal-code-review` or `/marshal-pr-ops` for per-PR gating. This skill is whole-repo, not diff-scoped.
- Use `pnpm exec fallow audit` (not this skill) if you want a changed-files-only gate.
- Don't run this during active debugging sessions — it's for periodic check-ins, not incident response.
