// Hand-written declarations for lib/identity-verification.mjs so TypeScript consumers (the
// electron/ipc composition test that feeds the REAL runtime-ui:getPlacements handler output through
// this facility's extractor/verifier) can import it under `strict` without an implicit-any error.
// Shapes intentionally stay loose (unknown-heavy): the .mjs is the single source of truth and does
// its own runtime validation — these declarations only describe the call surface.

export interface DeclaredActionsGateResult {
  readonly applicable: boolean;
  readonly met?: boolean;
  readonly declaredActions?: readonly string[];
  readonly declaredTools?: readonly string[];
  readonly revisionId?: string;
  readonly reason?: string;
}

export function verifyInstalledIdentity(args: Record<string, unknown>): Record<string, unknown>;

export function verifyApplicationPublication(args: Record<string, unknown>): {
  readonly applicable: boolean;
  readonly met?: boolean;
  readonly revisionId?: string;
  readonly reason?: string;
};

export function findPublishedApplicationRecord(args: {
  readonly snapshot: unknown;
  readonly target: { readonly identity: string; readonly applicationId?: string };
}): Record<string, unknown> | null;

export function verifyDeclaredActions(args: {
  readonly target: {
    readonly identity: string;
    readonly applicationId?: string;
    readonly expectedDeclaredActions?: readonly string[];
    readonly expectedDeclaredTools?: readonly string[];
  };
  readonly matchedInstance: unknown;
  readonly publication:
    | { readonly success?: boolean; readonly error?: unknown; readonly record?: unknown }
    | undefined;
}): DeclaredActionsGateResult;
