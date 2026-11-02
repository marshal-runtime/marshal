import { describe, expect, it } from "vitest";

import { detectShellScripting, scriptingNudge } from "./scripting-nudge";

describe("detectShellScripting", () => {
  it.each([
    ["gh pr list --json number | jq '.[].number'", "jq"],
    ["python3 -c 'import json; print(1)'", "inline python"],
    ["python3 - <<'EOF'\nprint(1)\nEOF", "inline python"],
    ["node -e 'console.log(1)'", "inline node"],
    ["ps aux | awk '{print $2}'", "awk"],
    ["find . -name '*.ts' | xargs wc -l", "xargs"],
    ["for f in *.json; do cat $f; done", "a shell loop"],
    ["cat a | sort | uniq -c", "a 3-stage pipe"],
    ["git status; cat a | grep 'x|y' | sort | uniq -c", "a 4-stage pipe"],
  ])("flags %s", (command, signal) => {
    expect(detectShellScripting(command)).toBe(signal);
  });

  it.each([
    "git status --short",
    "pnpm test electron/foo.test.ts",
    "git log --oneline | head -5",
    "test -f a || echo missing",
    "ls ~/.jqrc",
    'grep -n "writeFile\\|\\.agent\\|entryPath" show-ui-tool.ts | head -40; wc -l show-ui-tool.ts',
    "ls a | wc -l; ls b; ls c | head -3; ls -la d | head -2",
    "git commit -F - <<'EOF'\nfix: pipe a | b | c through jq\nEOF",
    'git commit -m "for x in y; do z; done"',
  ])("leaves ordinary CLI use alone: %s", (command) => {
    expect(detectShellScripting(command)).toBeUndefined();
  });
});

describe("scriptingNudge", () => {
  it("names the scripting tool and states the command still runs", () => {
    const nudge = scriptingNudge("cat x | jq .", "runtimeExecuteTypeScript");
    expect(nudge).toContain("runtimeExecuteTypeScript");
    expect(nudge).toContain("running as sent");
  });

  it("ignores non-string commands", () => {
    expect(scriptingNudge(undefined, "runtimeExecuteTypeScript")).toBeUndefined();
  });
});
