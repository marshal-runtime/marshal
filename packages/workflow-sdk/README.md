# `@marshal/workflow-sdk`

Authoring SDK for Marshal Dynamic Workflows.

This package is a **foundation shell** delivered by IMPL-FOUNDATIONS. The
public type surface exists (matching `c-sdk.md` §1.1) so renderer and
skill author docs can import from `@marshal/workflow-sdk` at the
typecheck level. Runtime implementations (`defineWorkflow`,
`defineRenderer`, `defineArtifact`, the error classes) throw
`NotImplementedError` until IMPL-SDK fills them in.

See:

- `r1-fixes.md` — normative V1 contracts (supersedes per-component docs on conflict).
- `c-sdk.md` — the SDK design that this package implements.
- `c-runtime.md` — the engine that consumes definitions produced by this SDK.
