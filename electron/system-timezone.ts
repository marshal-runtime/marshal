import { toIANATimezone } from "./timezone-utils";

/**
 * The system timezone as an IANA name that Intl.DateTimeFormat accepts.
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is not reliable when the
 * process has an invalid `TZ`: Node 22.18+ on macOS returns `undefined` for
 * `TZ="Pacific Standard Time"`, and some platforms return `"Etc/Unknown"`.
 * Both are rejected in favor of `process.env.TZ` (normalized from a Windows
 * timezone name when needed), then `"UTC"`.
 */
export function getSystemTimezone(): string {
  const resolvedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (resolvedTimezone && resolvedTimezone !== "Etc/Unknown") return resolvedTimezone;
  if (process.env.TZ) return toIANATimezone(process.env.TZ);
  return "UTC";
}
