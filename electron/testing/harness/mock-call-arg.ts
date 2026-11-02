/**
 * Extract a typed argument from a mock's call history.
 * Use only when the real function parameter is inherently `unknown` or `any`
 * (e.g. `apiPost`'s body param, `webContents.send`'s rest args).
 * For mocks where the real function has specific param types, fix the mock typing instead.
 *
 * The `T extends unknown ? T : never` return encodes T in two positions so the
 * type parameter is meaningfully used in the signature (and resolves to T for
 * any caller). Keeps `mockCallArg<X>(...)` usable without the
 * `no-unnecessary-type-parameters` rule firing.
 */
// Marshal ownership: relocated module identity.
export function mockCallArg<T>(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
  argIndex: number,
): T extends unknown ? T : never {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- centralized cast for mock call args
  return mock.mock.calls[callIndex][argIndex] as T extends unknown ? T : never;
}
