/**
 * Create a partial test double that satisfies the type system.
 * The unsafe cast is centralized here so individual test files don't need eslint-disable comments.
 *
 * ## Preferred patterns for mocking Node `fs` (type-aware lint passes cleanly)
 *
 * `fs.readdirSync`, `fs.statSync`, `fs.Dirent`, etc. have multiple overloads that
 * Vitest's `vi.mocked(...)` collapses in ways that don't accept plain values without
 * a cast. The canonical fix in this codebase is to wrap values in `testDouble(...)`
 * instead of ad-hoc `as any` or `as <overload signature>` casts — the narrow overload
 * casts don't satisfy the wider mock signature and produce TS2345 errors that
 * tsgolint promotes to lint failures.
 *
 * ```ts
 * // ✅ GOOD — canonical pattern
 * mockedFs.readdirSync.mockReturnValue(testDouble(["a.md", "b.md"]));
 * mockedFs.statSync.mockReturnValue(testDouble<fs.Stats>({ isFile: () => true }));
 * mockedFs.readFileSync.mockImplementation((p) => String(p).includes("a") ? "A" : "");
 * mockedFs.copyFileSync.mockImplementation((_src, dest) => { ... });
 *
 * // ❌ BAD — oxlint `typescript-eslint(no-unsafe-type-assertion)` fails
 * mockedFs.readdirSync.mockReturnValue(["a.md", "b.md"] as any);
 *
 * // ❌ ALSO BAD — narrow overload cast doesn't satisfy mock signature (TS2345)
 * mockedFs.readFileSync.mockImplementation(((p: fs.PathLike) => "...") as (path: fs.PathLike) => string);
 * ```
 *
 * For `mockImplementation`, the general rule: drop explicit param types on the callback
 * and let the mock's inferred overload drive inference. If a value (not a function) needs
 * a shaped cast, wrap it in `testDouble<T>(...)`.
 *
 * See `automations.test.ts` and `heartbeat.test.ts` for reference usage.
 */
// Marshal ownership: relocated module identity.
export function testDouble<T>(partial: object): T extends unknown ? T : never {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- centralized cast for all test doubles
  return partial as unknown as T extends unknown ? T : never;
}
