import type {
  RuntimeUiCardAnchor,
  RuntimeUiInstance,
  RuntimeUiSurface,
  RuntimeUiTransientState,
  RuntimeUiViewOptions,
} from "../../common/runtime-ui";

const SLOT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const MIN_TRANSIENT_TIMEOUT_MS = 1_000;
const MAX_TRANSIENT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_TITLE_LENGTH = 256;
const MAX_MESSAGE_ID_LENGTH = 256;

export interface NormalizedViewOptions {
  readonly title?: string;
  readonly transient?: RuntimeUiTransientState;
  readonly anchor?: RuntimeUiCardAnchor;
}

type Fail = (message: string) => Error;

/**
 * Validates open-time view options against the target surface. Transient and
 * anchored views are both chat cards, and a card is one or the other: a
 * transient card never enters the transcript, so it cannot be anchored.
 */
export function normalizeViewOptions(
  options: RuntimeUiViewOptions,
  surface: RuntimeUiSurface,
  now: number,
  fail: Fail,
): NormalizedViewOptions {
  const title = normalizeTitle(options.title, fail);
  if (options.transient !== undefined && options.anchor !== undefined) {
    throw fail("A transient card cannot be anchored in the transcript.");
  }
  if (
    (options.transient !== undefined || options.anchor !== undefined) &&
    surface !== "inline-card"
  )
    throw fail("Transient and anchored views must use the inline-card surface.");
  return {
    ...(title ? { title } : {}),
    ...(options.transient !== undefined
      ? { transient: normalizeTransient(options.transient, now, fail) }
      : {}),
    ...(options.anchor !== undefined ? { anchor: normalizeAnchor(options.anchor, fail) } : {}),
  };
}

function normalizeTitle(value: unknown, fail: Fail): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TITLE_LENGTH) {
    throw fail(`View title must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters.`);
  }
  return value.trim();
}

function normalizeTransient(value: unknown, now: number, fail: Fail): RuntimeUiTransientState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail("Transient options must be an object.");
  }
  const timeoutMs: unknown = Reflect.get(value, "timeoutMs");
  if (timeoutMs === undefined) return {};
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TRANSIENT_TIMEOUT_MS ||
    timeoutMs > MAX_TRANSIENT_TIMEOUT_MS
  ) {
    throw fail(
      `Transient timeoutMs must be an integer between ${MIN_TRANSIENT_TIMEOUT_MS} and ${MAX_TRANSIENT_TIMEOUT_MS}.`,
    );
  }
  return { expiresAt: new Date(now + timeoutMs).toISOString() };
}

function normalizeAnchor(value: unknown, fail: Fail): RuntimeUiCardAnchor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail("Card anchor must be an object.");
  }
  const slot: unknown = Reflect.get(value, "slot");
  const afterMessageId: unknown = Reflect.get(value, "afterMessageId");
  if (slot !== undefined && (typeof slot !== "string" || !SLOT_PATTERN.test(slot))) {
    throw fail("Card slot must be 1-64 letters, digits, '.', '_' or '-'.");
  }
  if (
    afterMessageId !== undefined &&
    (typeof afterMessageId !== "string" ||
      !afterMessageId.trim() ||
      afterMessageId.length > MAX_MESSAGE_ID_LENGTH)
  ) {
    throw fail("Card afterMessageId must be a non-empty message id.");
  }
  if (slot === undefined && afterMessageId === undefined) {
    throw fail("Card anchor needs a slot or an afterMessageId.");
  }
  return {
    ...(typeof slot === "string" ? { slot } : {}),
    ...(typeof afterMessageId === "string" ? { afterMessageId } : {}),
  };
}

/** The raw view options of a command, kept unnormalized so idempotency digests stay time-independent. */
export function pickViewOptions(command: RuntimeUiViewOptions): RuntimeUiViewOptions {
  return {
    ...(command.title === undefined ? {} : { title: command.title }),
    ...(command.transient === undefined ? {} : { transient: command.transient }),
    ...(command.anchor === undefined ? {} : { anchor: command.anchor }),
  };
}

/**
 * The view fields a view keeps when it moves to `surface`: cards that leave
 * the chat become ordinary docked tabs, so their card-only state is dropped.
 */
export function viewFieldsForSurface(
  instance: RuntimeUiInstance,
  surface: RuntimeUiSurface,
): Pick<RuntimeUiInstance, "title" | "transient" | "anchor"> {
  return {
    ...(instance.title ? { title: instance.title } : {}),
    ...(surface === "inline-card" && instance.transient ? { transient: instance.transient } : {}),
    ...(surface === "inline-card" && instance.anchor ? { anchor: instance.anchor } : {}),
  };
}

/** Closes transient cards when their timeout passes. */
export class RuntimeUiExpiryScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly clock: () => number,
    private readonly onExpire: (instanceId: string) => void,
  ) {}

  sync(instance: RuntimeUiInstance): void {
    this.cancel(instance.instanceId);
    const expiresAt = instance.transient?.expiresAt;
    if (!expiresAt) return;
    const delay = Math.max(0, Date.parse(expiresAt) - this.clock());
    const timer = setTimeout(() => {
      this.timers.delete(instance.instanceId);
      this.onExpire(instance.instanceId);
    }, delay);
    timer.unref?.();
    this.timers.set(instance.instanceId, timer);
  }

  cancel(instanceId: string): void {
    const timer = this.timers.get(instanceId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(instanceId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
