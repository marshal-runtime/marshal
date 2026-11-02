#!/usr/bin/env bash
# Runs every formal check and compares each result with its EXPECTED outcome:
#   hold      - TLC finds no error / Lean builds with standard axioms only
#   violated  - TLC must find a counterexample in the pre-fix model (Fixed =
#               FALSE), proving the property is sensitive to the fix
# Exits non-zero if any result differs from its expectation.
#
#   formal/run.sh            TLC + Lean + repro tests
#   formal/run.sh tla|lean|repro
set -uo pipefail

formal_dir="$(cd "$(dirname "$0")" && pwd)"
repo_dir="$(cd "$formal_dir/.." && pwd)"
tools_dir="${MARSHAL_FORMAL_TOOLS:-$HOME/.cache/marshal-formal}"
only="${1:-all}"
failures=0
results=()

record() { # name expected actual
  local status="ok"
  [ "$2" = "$3" ] || { status="MISMATCH"; failures=$((failures + 1)); }
  results+=("$(printf '%-9s %-46s expected=%-9s actual=%s' "$status" "$1" "$2" "$3")")
}

java_bin() {
  local jdk
  jdk="$(ls -d "$tools_dir"/jdk-* 2>/dev/null | head -1)"
  if [ -n "$jdk" ] && [ -x "$jdk/Contents/Home/bin/java" ]; then echo "$jdk/Contents/Home/bin/java"
  elif [ -n "$jdk" ] && [ -x "$jdk/bin/java" ]; then echo "$jdk/bin/java"
  else echo java; fi
}

# tlc SPEC CFG -> prints "hold" | "violated" | "error"
tlc() {
  local spec="$1" cfg="$2" meta log
  meta="$(mktemp -d)"; log="$meta/tlc.log"
  (cd "$formal_dir/tla" && "$(java_bin)" -XX:+UseParallelGC -cp "$tools_dir/tla2tools.jar" \
    tlc2.TLC -workers auto -metadir "$meta/states" -config "$cfg" "$spec" >"$log" 2>&1)
  if grep -q "No error has been found" "$log"; then echo hold
  elif grep -qE "is violated|Temporal properties were violated" "$log"; then echo violated
  else echo error; tail -20 "$log" >&2; fi
  rm -rf "$meta"
}

# Runs each INVARIANT/PROPERTY of CFG on its own (so one counterexample does
# not mask the next) and expects every one of them to be violated.
tlc_each_violated() {
  local spec="$1" cfg="$2" base names name kind tmp single
  base="$(grep -vE '^(INVARIANTS?|PROPERTY|PROPERTIES) ' "$formal_dir/tla/$cfg")"
  for kind in INVARIANTS PROPERTIES; do
    names="$(grep -E "^$kind " "$formal_dir/tla/$cfg" | cut -d' ' -f2-)"
    for name in $names; do
      tmp="$formal_dir/tla/.single-$name.cfg"
      [ "$kind" = INVARIANTS ] && single=INVARIANT || single=PROPERTY
      printf '%s\n%s %s\n' "$base" "$single" "$name" >"$tmp"
      record "tla ${spec%.tla}::$name" violated "$(tlc "$spec" "$(basename "$tmp")")"
      rm -f "$tmp"
    done
  done
}

run_tla() {
  [ -f "$tools_dir/tla2tools.jar" ] || { echo "Missing $tools_dir/tla2tools.jar; run formal/setup.sh" >&2; exit 2; }
  echo "TLC: goal engine (current), exhaustive..."
  record "tla GoalEngine.cfg (all goal properties)" hold "$(tlc GoalEngine.tla GoalEngine.cfg)"
  echo "TLC: goal engine before the fixes (expected counterexamples)..."
  tlc_each_violated GoalEngine.tla GoalEngineRace.cfg
  tlc_each_violated GoalEngine.tla GoalEngineCap.cfg
  echo "TLC: swarm run lifecycle (current), exhaustive..."
  record "tla SwarmRun.cfg (safety + liveness)" hold "$(tlc SwarmRun.tla SwarmRun.cfg)"
  echo "TLC: swarm before the fixes (expected counterexamples)..."
  tlc_each_violated SwarmRun.tla SwarmRunDesign.cfg
}

run_lean() {
  local lake_bin audit
  lake_bin="$(command -v lake || echo "$HOME/.elan/bin/lake")"
  [ -x "$lake_bin" ] || { echo "Missing lake; run formal/setup.sh" >&2; exit 2; }
  echo "Lean: building proofs..."
  if (cd "$formal_dir/lean" && "$lake_bin" build >/dev/null 2>&1); then
    record "lean build (all theorems)" hold hold
  else
    record "lean build (all theorems)" hold error
    (cd "$formal_dir/lean" && "$lake_bin" build 2>&1 | tail -30) >&2
    return
  fi
  audit="$(cd "$formal_dir/lean" && "$lake_bin" env lean MarshalFormal/Audit.lean 2>&1)"
  local expected reported unexpected
  expected="$(grep -c '^#print axioms' "$formal_dir/lean/MarshalFormal/Audit.lean")"
  reported="$(echo "$audit" | grep -cE 'depends on axioms|does not depend on any axioms')"
  unexpected="$(echo "$audit" | grep -oE 'axioms: \[[^]]*\]' | sed -E 's/axioms: \[(.*)\]/\1/' |
    tr ',' '\n' | sed 's/ //g' | grep -vxE 'propext|Quot\.sound|Classical\.choice' || true)"
  if [ "$reported" = "$expected" ] && [ -z "$unexpected" ] && ! echo "$audit" | grep -q 'error'; then
    record "lean axiom audit (no sorry/custom axioms)" hold hold
  else
    record "lean axiom audit (no sorry/custom axioms)" hold error
    echo "$audit" >&2
  fi
}

run_repro() {
  echo "Vitest: replaying counterexamples against the installed swarm pack..."
  local out
  out="$(cd "$repo_dir" && pnpm exec vitest run --config formal/repro/vitest.config.ts 2>&1)"
  local files_line
  files_line="$(echo "$out" | grep -E "Test Files" | tail -1)"
  if echo "$files_line" | grep -qE "[0-9]+ passed" && ! echo "$files_line" | grep -q "failed"; then
    record "repro (installed swarm pack enforces the fixes)" hold hold
  else
    record "repro (installed swarm pack enforces the fixes)" hold error
    echo "$out" | tail -30 >&2
  fi
}

case "$only" in
  tla) run_tla ;;
  lean) run_lean ;;
  repro) run_repro ;;
  all) run_tla; run_lean; run_repro ;;
  *) echo "usage: formal/run.sh [all|tla|lean|repro]" >&2; exit 2 ;;
esac

echo
printf '%s\n' "${results[@]}"
echo
if [ "$failures" -eq 0 ]; then echo "All ${#results[@]} checks matched expectations."
else echo "$failures check(s) did not match expectations."; exit 1; fi
