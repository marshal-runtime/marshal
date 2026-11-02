type TimezoneLogger = {
  info: (message: string) => void;
  warn: (message: string, error?: unknown) => void;
};

/**
 * Reports whether V8's Intl can parse a timezone without rewriting it.
 * "Etc/Unknown" is rejected because V8 formats it as UTC on some ICU builds.
 */
function isParseableIANA(tz: string): boolean {
  if (!tz || tz === "Etc/Unknown") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function normalizeProcessTZ(
  env: Partial<NodeJS.ProcessEnv>,
  windowsToIana: Readonly<Record<string, string>>,
  log: TimezoneLogger,
): void {
  const initial = env.TZ;

  if (initial) {
    const mapped = windowsToIana[initial];
    if (mapped) {
      env.TZ = mapped;
      log.info(`TZ normalized: "${initial}" → "${mapped}"`);
      return;
    }
    if (isParseableIANA(initial)) {
      log.info(`TZ already valid: "${initial}"`);
      return;
    }
    delete env.TZ;
    log.warn(`TZ "${initial}" is unparseable; deleted so V8 uses OS detection`);
    return;
  }

  try {
    const intl = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (intl && isParseableIANA(intl)) {
      env.TZ = intl;
      log.info(`TZ resolved from Intl: "${intl}"`);
    } else {
      log.warn(`TZ unset and Intl returned ${intl ? `"${intl}"` : "undefined"}; leaving TZ unset`);
    }
  } catch (err) {
    log.warn("TZ unset and Intl threw; leaving TZ unset:", err);
  }
}
