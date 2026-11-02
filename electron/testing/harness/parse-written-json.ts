/**
 * Parse JSON from an `fs.writeFileSync` mock call's data argument.
 *
 * `writeFileSync`'s second parameter is typed `string | ArrayBufferView`.
 * In tests we always write JSON strings, but the union type prevents a direct
 * `JSON.parse(data)` without a cast. This helper narrows with a runtime check
 * so callers stay assertion-free.
 */
// Marshal ownership: relocated module identity.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON.parse returns any; callers access dynamic keys
export function parseWrittenJson(data: unknown): any {
  if (typeof data !== "string") {
    throw new Error(`Expected string data from writeFileSync, got ${typeof data}`);
  }
  return JSON.parse(data);
}
