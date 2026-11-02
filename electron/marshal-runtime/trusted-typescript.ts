/**
 * Full-Node ("trusted") TypeScript execution for agent-authored modules.
 *
 * Brokered execution can only call runtime.search / runtime.invoke, which makes
 * it useless for ordinary local work, so agents never reach for it. Trusted
 * execution gives authored modules Node builtins and installed packages.
 *
 * This is deliberately NOT routed through the permission policy yet: the goal
 * of the first iteration is to learn how agents use it. It therefore defaults
 * on only for unpackaged (developer) builds; packaged builds stay brokered
 * unless MARSHAL_RUNTIME_TRUSTED_TYPESCRIPT opts in.
 */
export const TRUSTED_TYPESCRIPT_ENV = "MARSHAL_RUNTIME_TRUSTED_TYPESCRIPT";

export const TRUSTED_TYPESCRIPT_PERMISSIONS: ReadonlySet<string> = new Set([
  "runtime.inline_module.execute.trusted",
  "runtime.module.execute.trusted",
]);

export const TRUSTED_TYPESCRIPT_IMPORT_POLICY = Object.freeze({
  allowedPackages: Object.freeze(["*"]),
  allowedBuiltins: Object.freeze(["*"]),
});

export function isTrustedTypeScriptEnabled(options: {
  readonly isPackaged: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): boolean {
  const configured = (options.env ?? process.env)[TRUSTED_TYPESCRIPT_ENV]?.trim().toLowerCase();
  if (configured === "1" || configured === "true") return true;
  if (configured === "0" || configured === "false") return false;
  return !options.isPackaged;
}
