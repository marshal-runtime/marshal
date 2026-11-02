# local/

Runtime-neutral infrastructure shared by local adapters whose clients implement
`runtime-contract.ts`.

- `provider.ts` composes the local session, tool, automation, permissions, MCP,
  lifecycle, model, and client-native auth machinery.
- `strategy.ts` is the runtime-specific configuration seam: identity, origin,
  capabilities, model defaults, process-tool names, workspace files, and auth.
- `session.ts`, `tools.ts`, `automation.ts`, and `permissions.ts` implement the
  backend sub-interfaces once for all local adapters.
- `runtime-auth.ts` validates and maps the optional typed client auth contract.
- `approval-adapter.ts` wires local runtime permission callbacks to the shared
  approval broker.

Do not add runtime identity branches here. Runtime-specific SDK conversion,
client factories, auth fallbacks, and dependency imports stay in
`electron/backend/<runtime>/` and enter through `LocalRuntimeStrategy` or the
neutral runtime client contract.
