/**
 * Structured logger for Marshal.
 *
 * Usage:
 *   import { createLogger } from "../common/marshal-logger";
 *   const log = createLogger("SessionManager");
 *   log.info("Session created", sessionId);
 *   log.warn("Retrying after auth error");
 *   log.error("Failed to persist:", err);
 *
 * Sub-modules:
 *   const requestLog = log.child("request");  // → [Session:request]
 *
 * Runtime context:
 *   const slog = log.with({ sessionId });   // → [SessionManager] [ses_abc] ...
 *
 * @see docs/architecture/17-marshal-logging.md
 */

// ── Types ───────────────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error";

/**
 * Privacy-safe error code for `log.fault()` entries. Identical to the
 * Shared structured error-code shape used by the telemetry adapter.
 */
export interface FaultCode {
  family: string;
  code: number;
}

export interface LogEntry {
  level: LogLevel;
  tag: string;
  context: Record<string, string>;
  args: unknown[];
  timestamp: number;
  /** Set only on entries produced by `log.fault()`. Drives telemetry
   *  push sinks. Other entries leave this undefined. */
  telemetry?: FaultCode;
  /** Set only on entries produced by `log.fault()`. Telemetry sinks may use
   *  this to mark the error in a dedup set so the IPC catch-all doesn't
   *  double-emit a HANDLER_UNCAUGHT for an already-instrumented failure. */
  cause?: unknown;
  /** Set only on entries produced by `log.event()`. Drives the telemetry
   *  event push sink — forwarded to the renderer's telemetry pipeline. */
  event?: TelemetryEvent;
}

/** Structured telemetry event payload for `log.event()`. */
export interface TelemetryEvent {
  scenario: string;
  fields: Record<string, unknown>;
}
type LogSink = (entry: LogEntry) => void;

interface Logger {
  // ── Console logging (diagnostic output for humans) ──────────────────────
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;

  // ── Structured error telemetry (privacy-safe error codes) ─────
  /**
   * Emit a fault: a structured error code paired with a console/disk line.
   * Always logs at `"error"` level so the existing console + diagnostic-disk
   * sinks render it without changes; the `telemetry` field is what telemetry
   * sinks key off. Pass the originating error as `cause` so dedup sinks can
   * mark it.
   */
  fault(code: FaultCode, cause?: unknown, ...args: unknown[]): void;

  // ── Structured event telemetry (business metrics) ─────────────
  /**
   * Emit a structured telemetry event. Routes through registered sinks
   * — the telemetry event sink forwards to the renderer's telemetry pipeline
   * via IPC. Always logs at `"info"` level.
   */
  event(scenario: string, fields: Record<string, unknown>): void;

  // ── Scoping ─────────────────────────────────────────────────────────────
  /** Create a child logger with a sub-label: `[Parent:child]` */
  child(sublabel: string): Logger;
  /** Create a logger that attaches runtime context to every entry */
  with(context: Record<string, string>): Logger;
}

// ── Sinks ───────────────────────────────────────────────────────────────────

const sinks: LogSink[] = [];

function formatContext(context: Record<string, string>): string {
  const values = Object.values(context);
  if (values.length === 0) return "";
  return " " + values.map((v) => `[${v}]`).join(" ");
}

// ── Tag coloring ────────────────────────────────────────────────────────────

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Convert HSL (h: 0-360, s/l: 0-100) to RGB tuple. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const s1 = s / 100;
  const l1 = l / 100;
  const c = (1 - Math.abs(2 * l1 - 1)) * s1;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l1 - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const ANSI_RESET = "\x1b[0m";

const isNode = typeof process !== "undefined" && typeof process.stdout !== "undefined";

const supportsColor =
  isNode && process.stdout.isTTY && !process.env["NO_COLOR"] && process.env["TERM"] !== "dumb";

interface TagStyle {
  ansi?: string;
  css?: string;
}

const tagStyleCache = new Map<string, TagStyle>();

function getTagStyle(tag: string): TagStyle {
  let style = tagStyleCache.get(tag);
  if (!style) {
    // Color by root tag so parent and children share the same hue.
    // Multiply by a large prime then mod 360 to spread similar strings apart.
    const rootTag = tag.split(":")[0];
    const hue = (hashString(rootTag) * 49979) % 360;
    const [r, g, b] = hslToRgb(hue, 80, isNode ? 65 : 55);
    style = {
      ansi: `\x1b[38;2;${r};${g};${b}m`,
      css: `color:rgb(${r},${g},${b});font-weight:bold`,
    };
    tagStyleCache.set(tag, style);
  }
  return style;
}

/** Module-scoped opt-in for inline wall-clock timestamps in the console sink.
 *  Key is the root tag (the segment before the first `:`). Subloggers
 *  (`createLogger("X").child("y")`) inherit by tagging the root. */
const timestampedRootTags = new Set<string>();

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `[${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}] `;
}

/** Default sink — writes to console with colored `[Tag]` prefix. */
function consoleSink(entry: LogEntry): void {
  const ctx = formatContext(entry.context);
  const style = getTagStyle(entry.tag);
  const method = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "log";
  const rootTag = entry.tag.split(":")[0];
  const ts = timestampedRootTags.has(rootTag) ? formatTimestamp(entry.timestamp) : "";
  if (isNode) {
    if (supportsColor) {
      const prefix = `${ts}${style.ansi}[${entry.tag}]${ANSI_RESET}${ctx}`;
      console[method](prefix, ...entry.args);
    } else {
      const prefix = `${ts}[${entry.tag}]${ctx}`;
      console[method](prefix, ...entry.args);
    }
  } else {
    const prefix = `${ts}%c[${entry.tag}]%c${ctx}`;
    console[method](prefix, style.css, "", ...entry.args);
  }
}

sinks.push(consoleSink);

/**
 * Register an additional log sink. Returns an unsubscribe function.
 *
 * ```ts
 * const remove = addLogSink((entry) => sendToTelemetry(entry));
 * // later:
 * remove();
 * ```
 */
export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const idx = sinks.indexOf(sink);
    if (idx >= 0) sinks.splice(idx, 1);
  };
}

// ── Logger factory ──────────────────────────────────────────────────────────

function emit(
  level: LogLevel,
  tag: string,
  context: Record<string, string>,
  args: unknown[],
  extras?: { telemetry?: FaultCode; cause?: unknown; event?: TelemetryEvent },
): void {
  const entry: LogEntry = {
    level,
    tag,
    context,
    args,
    timestamp: Date.now(),
    ...(extras?.telemetry !== undefined ? { telemetry: extras.telemetry } : {}),
    ...(extras?.cause !== undefined ? { cause: extras.cause } : {}),
    ...(extras?.event !== undefined ? { event: extras.event } : {}),
  };
  for (const sink of sinks.slice()) {
    try {
      sink(entry);
    } catch {
      // Never let a sink break the logging pipeline
    }
  }
}

function makeLogger(tag: string, context: Record<string, string>): Logger {
  return {
    info: (...args) => emit("info", tag, context, args),
    warn: (...args) => emit("warn", tag, context, args),
    error: (...args) => emit("error", tag, context, args),
    fault: (code, cause, ...args) => emit("error", tag, context, args, { telemetry: code, cause }),
    event: (scenario, fields) =>
      emit("info", tag, context, [`[${scenario}]`], { event: { scenario, fields } }),
    child: (sublabel) => makeLogger(`${tag}:${sublabel}`, context),
    with: (ctx) => makeLogger(tag, { ...context, ...ctx }),
  };
}

/**
 * Create a module-scoped logger.
 *
 * ```ts
 * const log = createLogger("SessionManager");
 * log.info("Session created");  // → [SessionManager] Session created
 * ```
 */
export interface CreateLoggerOptions {
  /** Prepend an `[HH:MM:SS.mmm]` wall-clock stamp to console-sink lines for
   *  this tag (and any child tags). Off by default. Use for hot, latency-
   *  sensitive surfaces (RPC transport, reconnect loops) where correlating
   *  events on the time axis matters. The stamp is rendered only by the
   *  console sink; structured sinks (telemetry, disk dumps) read
   *  `entry.timestamp` directly. */
  timestamps?: boolean;
}

export function createLogger(tag: string, opts?: CreateLoggerOptions): Logger {
  if (opts?.timestamps) timestampedRootTags.add(tag.split(":")[0]);
  return makeLogger(tag, {});
}
