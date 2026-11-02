import { inspect } from "node:util";

const inspectOptions = { depth: 4, breakLength: Infinity, compact: true } as const;
const EMPTY_LOG_ARG = "";

function isJsonSafeValue(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "bigint":
    case "symbol":
    case "function":
    case "undefined":
      return false;
    case "object":
      break;
    default:
      return false;
  }

  if (value instanceof Error) return false;
  if (seen.has(value)) return false;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !isJsonSafeValue(value[index], seen)) {
          return false;
        }
      }

      if (
        Object.keys(value).some((key) => {
          const index = Number(key);
          return (
            !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key
          );
        })
      ) {
        return false;
      }

      if (
        Object.getOwnPropertySymbols(value).some((symbolKey) =>
          Object.prototype.propertyIsEnumerable.call(value, symbolKey),
        )
      ) {
        return false;
      }

      return true;
    }

    if (
      Object.getOwnPropertySymbols(value).some((symbolKey) =>
        Object.prototype.propertyIsEnumerable.call(value, symbolKey),
      )
    ) {
      return false;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }

    for (const propertyValue of Object.values(value)) {
      if (!isJsonSafeValue(propertyValue, seen)) {
        return false;
      }
    }

    return true;
  } finally {
    seen.delete(value);
  }
}

export function serializeLogArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg == null) return EMPTY_LOG_ARG;
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === "bigint") return arg.toString();
  if (typeof arg === "symbol") return String(arg);
  if (typeof arg === "function") {
    return arg.name ? `[Function: ${arg.name}]` : "[Function]";
  }
  if (typeof arg === "number" || typeof arg === "boolean") {
    return String(arg);
  }

  if (typeof arg === "object") {
    try {
      if (isJsonSafeValue(arg, new WeakSet())) {
        return JSON.stringify(arg);
      }
    } catch {
      // Fall back to inspect below when safety checks or stringify fail.
    }
  }

  try {
    return inspect(arg, inspectOptions);
  } catch {
    return "[unserializable]";
  }
}
