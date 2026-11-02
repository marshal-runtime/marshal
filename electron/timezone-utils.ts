/**
 * Timezone normalization utilities.
 *
 * Some hosts and services report Windows timezone IDs (e.g., "Pacific
 * Standard Time") instead of IANA zones. Intl.DateTimeFormat only accepts
 * IANA zones (e.g., "America/Los_Angeles") and throws on Windows IDs. Without
 * normalization, the per-turn date anchor silently falls back to ISO UTC
 * format and the model treats UTC as local time.
 *
 * Mapping subset covers the common Windows timezone IDs;
 * unknown/exotic names fall back to UTC with a logger warning for
 * diagnostics. Subset sourced from Unicode CLDR windowsZones.xml; expand
 * as needed.
 */

import { createLogger } from "../common/marshal-logger";
import { normalizeProcessTZ as normalizeProcessTZPlatform } from "./platform/time/normalize-process-tz";

const log = createLogger("TimezoneUtils");

const WINDOWS_TO_IANA: Record<string, string> = {
  "Alaskan Standard Time": "America/Anchorage",
  "Arab Standard Time": "Asia/Riyadh",
  "Arabian Standard Time": "Asia/Dubai",
  "Atlantic Standard Time": "America/Halifax",
  "AUS Central Standard Time": "Australia/Darwin",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "Central Standard Time": "America/Chicago",
  "China Standard Time": "Asia/Shanghai",
  "E. Africa Standard Time": "Africa/Nairobi",
  "E. Europe Standard Time": "Europe/Chisinau",
  "Eastern Standard Time": "America/New_York",
  "Egypt Standard Time": "Africa/Cairo",
  "FLE Standard Time": "Europe/Kyiv",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "GTB Standard Time": "Europe/Bucharest",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "India Standard Time": "Asia/Kolkata",
  "Israel Standard Time": "Asia/Jerusalem",
  "Korea Standard Time": "Asia/Seoul",
  "Mexico Standard Time": "America/Mexico_City",
  "Mountain Standard Time": "America/Denver",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Pacific Standard Time": "America/Los_Angeles",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "Romance Standard Time": "Europe/Paris",
  "Russian Standard Time": "Europe/Moscow",
  "SA Eastern Standard Time": "America/Cayenne",
  "SA Pacific Standard Time": "America/Bogota",
  "SA Western Standard Time": "America/La_Paz",
  "SE Asia Standard Time": "Asia/Bangkok",
  "Singapore Standard Time": "Asia/Singapore",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Taipei Standard Time": "Asia/Taipei",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Turkey Standard Time": "Europe/Istanbul",
  "US Eastern Standard Time": "America/Indianapolis",
  "US Mountain Standard Time": "America/Phoenix",
  "W. Europe Standard Time": "Europe/Berlin",
};

/**
 * Return an IANA timezone string that Intl.DateTimeFormat will accept.
 * Accepts:
 *   - IANA names ("America/Los_Angeles") — returned as-is after Intl validation.
 *   - Windows names ("Pacific Standard Time") — mapped via WINDOWS_TO_IANA table.
 *   - Anything else — logged and replaced with "UTC".
 *
 * Never throws. Callers can use the result directly with Intl.DateTimeFormat.
 */
export function toIANATimezone(tz: string): string {
  // Check the Windows→IANA map first. Some Node/ICU builds (notably on
  // Windows) accept Windows timezone names as valid Intl zones without
  // throwing, which would otherwise cause this function to return e.g.
  // "Pacific Standard Time" unchanged and defeat the purpose of normalization.
  // Mapping first guarantees identical cross-platform output.
  const mapped = WINDOWS_TO_IANA[tz];
  if (mapped) return mapped;
  try {
    // Intl.DateTimeFormat throws on invalid timezones at construction time.
    // Chaining `.format(epoch)` consumes the instance, which both proves the
    // TZ is usable by later callers and avoids the `no-new` lint rule that
    // flags constructor calls used purely for their side effect.
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return tz;
  } catch {
    log.warn(`Unknown timezone "${tz}", falling back to UTC`);
    return "UTC";
  }
}

/**
 * Normalize the TZ env var so child processes (in particular the Electron
 * renderer's V8) inherit a value they can parse.
 *
 * Two failure modes drove this:
 *   1. Some enterprise Windows hosts (e.g. cloud dev boxes) export TZ as
 *      a Windows-format ID like "Pacific Standard Time". V8 can't parse
 *      those, so it silently falls back to UTC for both Intl and
 *      Date.prototype.getHours, leaking UTC into chat-message and picker
 *      timestamps.
 *   2. When TZ is unset, Intl in the sandboxed renderer occasionally
 *      returns "Etc/Unknown" or undefined even when the host is on a
 *      real IANA tz.
 *
 * Decision tree (logged at INFO/WARN so the diagnostic JSONL captures it):
 *   - TZ already a valid IANA → no-op
 *   - TZ in WINDOWS_TO_IANA   → rewrite to the mapped IANA name
 *   - TZ unparseable          → DELETE, so V8 falls back to OS detection
 *                               (do NOT stamp "UTC" — that locks UTC in
 *                               for users whose Windows ID isn't in our
 *                               table, e.g. "Tonga Standard Time")
 *   - TZ unset, Intl OK       → stamp the resolved IANA name
 *   - TZ unset, Intl unusable → no-op, renderer falls back to OS
 *
 * `env` defaults to `process.env`; tests inject a fake object.
 */
export function normalizeProcessTZ(env: Partial<NodeJS.ProcessEnv> = process.env): void {
  normalizeProcessTZPlatform(env, WINDOWS_TO_IANA, log);
}
