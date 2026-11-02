import { describe, expect, it } from "vitest";

import { unwrapLoginShellArgv, unwrapLoginShellCommandText } from "./shell-wrapper";

describe("unwrapLoginShellCommandText", () => {
  it("unwraps a single-quoted login-shell payload", () => {
    expect(unwrapLoginShellCommandText("/bin/zsh -lc 'git status'")).toBe("git status");
    expect(unwrapLoginShellCommandText("/bin/bash -lc 'pnpm test src/a.test.ts'")).toBe(
      "pnpm test src/a.test.ts",
    );
  });

  it("unwraps the rust-shlex double-quoted rendering with escapes", () => {
    expect(unwrapLoginShellCommandText('/bin/zsh -lc "git status"')).toBe("git status");
    expect(unwrapLoginShellCommandText('/bin/zsh -lc "echo \\"hi\\" \\$HOME"')).toBe(
      'echo "hi" $HOME',
    );
    expect(unwrapLoginShellCommandText('/bin/zsh -lc "git log \\`pwd\\`"')).toBe("git log `pwd`");
  });

  it("unwraps embedded single quotes in shlex form", () => {
    expect(unwrapLoginShellCommandText("/bin/zsh -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
  });

  it("unwraps a bare single-token payload and split or long flags", () => {
    expect(unwrapLoginShellCommandText("/bin/bash -lc ls")).toBe("ls");
    expect(unwrapLoginShellCommandText("/usr/bin/zsh -l -c 'git status'")).toBe("git status");
    expect(unwrapLoginShellCommandText("bash --login -c 'git status'")).toBe("git status");
    expect(unwrapLoginShellCommandText("zsh -ilc 'git status'")).toBe("git status");
  });

  it("keeps compound inner commands intact for segment-wise policy checks", () => {
    expect(unwrapLoginShellCommandText("/bin/zsh -lc 'git status && rm -rf /tmp/x'")).toBe(
      "git status && rm -rf /tmp/x",
    );
  });

  it("leaves non-wrapper commands untouched", () => {
    expect(unwrapLoginShellCommandText("git status")).toBe("git status");
    expect(unwrapLoginShellCommandText("powershell -Command ls")).toBe("powershell -Command ls");
    expect(unwrapLoginShellCommandText("python3 -c 'print(1)'")).toBe("python3 -c 'print(1)'");
  });

  it("fails closed for arbitrary executables that merely share a shell basename", () => {
    // NOT a trusted wrapper: /tmp/zsh is a different program; granting policy
    // on its "inner text" would misattribute what actually runs.
    expect(unwrapLoginShellCommandText("/tmp/zsh -lc 'git status'")).toBe(
      "/tmp/zsh -lc 'git status'",
    );
    expect(unwrapLoginShellCommandText("./zsh -lc 'git status'")).toBe("./zsh -lc 'git status'");
    // Non-allowlisted install locations (user-writable prefixes) stay wrapped.
    expect(unwrapLoginShellCommandText("/usr/local/bin/zsh -lc 'git status'")).toBe(
      "/usr/local/bin/zsh -lc 'git status'",
    );
    expect(unwrapLoginShellCommandText("/opt/homebrew/bin/bash -lc 'git status'")).toBe(
      "/opt/homebrew/bin/bash -lc 'git status'",
    );
    // Case variants are different files on case-sensitive filesystems.
    expect(unwrapLoginShellCommandText("/bin/ZSH -lc 'git status'")).toBe(
      "/bin/ZSH -lc 'git status'",
    );
  });

  it("keeps double-quoted payloads with live shell expansion wrapped", () => {
    // Rust shlex always escapes $ and backtick; unescaped ones are real
    // expansion whose value is policy-opaque.
    expect(unwrapLoginShellCommandText('/bin/zsh -lc "echo $HOME"')).toBe(
      '/bin/zsh -lc "echo $HOME"',
    );
    expect(unwrapLoginShellCommandText('/bin/zsh -lc "echo `pwd`"')).toBe(
      '/bin/zsh -lc "echo `pwd`"',
    );
    expect(unwrapLoginShellCommandText('/bin/zsh -lc "echo $(id)"')).toBe(
      '/bin/zsh -lc "echo $(id)"',
    );
  });

  it("leaves ambiguous or malformed wrappers untouched", () => {
    // No -c flag: the payload is a script path, not a command string.
    expect(unwrapLoginShellCommandText("/bin/zsh -l 'x.sh'")).toBe("/bin/zsh -l 'x.sh'");
    // Extra positional argv entries.
    expect(unwrapLoginShellCommandText("/bin/zsh -lc 'a' 'b'")).toBe("/bin/zsh -lc 'a' 'b'");
    expect(unwrapLoginShellCommandText('/bin/zsh -lc "a" trailing')).toBe(
      '/bin/zsh -lc "a" trailing',
    );
    // Unquoted multi-word payload is ambiguous (not a shlex rendering).
    expect(unwrapLoginShellCommandText("/bin/zsh -lc git status")).toBe("/bin/zsh -lc git status");
    // Unterminated quote.
    expect(unwrapLoginShellCommandText("/bin/zsh -lc 'git status")).toBe(
      "/bin/zsh -lc 'git status",
    );
    // Non-lic execution flags change semantics.
    expect(unwrapLoginShellCommandText("/bin/zsh -xlc 'git status'")).toBe(
      "/bin/zsh -xlc 'git status'",
    );
    // Two -c flags.
    expect(unwrapLoginShellCommandText("/bin/zsh -c -c 'git status'")).toBe(
      "/bin/zsh -c -c 'git status'",
    );
    // Empty payload.
    expect(unwrapLoginShellCommandText("/bin/zsh -lc ''")).toBe("/bin/zsh -lc ''");
    expect(unwrapLoginShellCommandText("")).toBe("");
  });
});

describe("unwrapLoginShellArgv", () => {
  it("unwraps the wrapped argv form", () => {
    expect(unwrapLoginShellArgv(["/bin/zsh", "-lc", "git status && ls"])).toBe("git status && ls");
    expect(unwrapLoginShellArgv(["bash", "--login", "-c", "pnpm test"])).toBe("pnpm test");
  });

  it("returns null for non-wrapper argv", () => {
    expect(unwrapLoginShellArgv(["rm", "-rf", "/tmp/x"])).toBeNull();
    expect(unwrapLoginShellArgv(["/bin/zsh", "-lc"])).toBeNull();
    expect(unwrapLoginShellArgv(["/bin/zsh", "-lc", "script.sh", "arg"])).toBeNull();
    expect(unwrapLoginShellArgv(["/bin/zsh", "-lc", "-x"])).toBeNull();
    expect(unwrapLoginShellArgv(["python3", "-c", "print(1)"])).toBeNull();
    expect(unwrapLoginShellArgv(["/bin/zsh", "-xlc", "git status"])).toBeNull();
  });

  it("fails closed for argv whose executable only shares a shell basename", () => {
    expect(unwrapLoginShellArgv(["/tmp/zsh", "-lc", "git status"])).toBeNull();
    expect(unwrapLoginShellArgv(["./bash", "-lc", "git status"])).toBeNull();
    expect(unwrapLoginShellArgv(["/usr/local/bin/zsh", "-lc", "git status"])).toBeNull();
  });
});
