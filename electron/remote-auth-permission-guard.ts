// Owned by the remote-auth permission guard.

import { tokenize } from "./permission-patterns";
import {
  getShellMode,
  stripOuterQuotes,
  stripPowerShellBacktickEscapes,
  type ShellMode,
} from "./shell-syntax-permission-utils";

const UNC_PATTERNS: RegExp[] = [
  // Bare `\\hostname` (no share) still triggers NetBIOS resolution + outbound SMB
  // auth at the OS level (Responder-style passive NetNTLM capture).
  /(?:^|[\s"'=:,])\\\\[^\\\s"']+/,
  /\\\\\?\\UNC\\/i,
  // `:` excluded from boundary set so `https://` / `s3://` aren't matched.
  /(?:^|[\s"'=,])\/\/[^/\s"']+\//,
];

function containsUncPath(input: string): boolean {
  return UNC_PATTERNS.some((re) => re.test(input));
}

const LOCAL_COMPUTER_NAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  ".",
  "$env:computername",
]);

// PowerShell binds parameters by unambiguous prefix and accepts the
// `-Param:value` colon-suffix form. Over-matching is acceptable (extra prompt,
// not a security hole).
function isPsParamPrefixFlag(token: string, fullName: string): boolean {
  const colonIdx = token.indexOf(":");
  const lower = (colonIdx === -1 ? token : token.slice(0, colonIdx)).toLowerCase();
  if (lower.length < 4) return false;
  return fullName.startsWith(lower);
}

// PowerShell exposes parameter aliases that bind to the same -ComputerName
// target. -CN and -ServerName are the common ones on Get-CimInstance and
// Get-EventLog. -CN stays exact (length below the prefix-floor) so it doesn't
// collide with -Co* / -Ci* parameters on other cmdlets.
function isComputerNameFlag(token: string): boolean {
  if (isPsParamPrefixFlag(token, "-computername") || isPsParamPrefixFlag(token, "-servername")) {
    return true;
  }
  const colonIdx = token.indexOf(":");
  const lower = (colonIdx === -1 ? token : token.slice(0, colonIdx)).toLowerCase();
  return lower === "-cn";
}

function hasRemoteComputerName(input: string): boolean {
  const tokens = tokenize(input);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!isComputerNameFlag(token)) continue;

    const colonIdx = token.indexOf(":");
    let valueToken: string | undefined;
    if (colonIdx !== -1) {
      const inline = token.slice(colonIdx + 1);
      valueToken = inline.length > 0 ? inline : undefined;
    } else {
      valueToken = tokens[i + 1];
    }

    // Missing value: treat as remote — safer than guessing local.
    if (!valueToken || valueToken.startsWith("-")) return true;
    const value = stripOuterQuotes(valueToken).toLowerCase();
    if (!LOCAL_COMPUTER_NAMES.has(value)) return true;
  }
  return false;
}

function isCimSessionFlag(token: string): boolean {
  return isPsParamPrefixFlag(token, "-cimsession");
}

function hasCimSessionArg(input: string): boolean {
  return tokenize(input).some(isCimSessionFlag);
}

/**
 * True when the command would initiate outbound authentication via a UNC path
 * (SMB), `-ComputerName <remote>` (WinRM/RPC), or `-CimSession <session>`.
 * AIRT finding — gated on PowerShell mode; these are Windows concepts.
 */
export function hasRemoteAuthVector(input: string, shellMode: ShellMode = getShellMode()): boolean {
  if (shellMode !== "powershell") return false;
  const trimmed = input.trim();
  if (!trimmed) return false;
  // Backtick-normalize once for all three checks — `` -C`o`mputerName `` decodes
  // to `-ComputerName` at runtime, same as `` `\`\host `` decodes to `\\host`.
  const normalized = stripPowerShellBacktickEscapes(trimmed);
  if (containsUncPath(normalized)) return true;
  if (hasRemoteComputerName(normalized)) return true;
  if (hasCimSessionArg(normalized)) return true;
  return false;
}
