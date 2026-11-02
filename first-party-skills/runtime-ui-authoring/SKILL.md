---
name: runtime-ui-authoring
description: Load before building interactive UI in Marshal — buttons or forms that call capabilities, persisted UI state, application manifests, the ui.compile → ui.render → ui.application.open loop, the marshal client, sandbox limits. Not needed for runtimeShowUi tables, boards, or plain custom tsx views.
---

# Runtime UI authoring (interactive UI)

Reference for authoring interactive React UI through the Marshal Runtime: the capability list, the verified compile → render → place loop, application manifests and declared actions, the in-component `marshal` client, sandbox limits, and the brokered-TypeScript worked example. Display-only views (data tables, status boards, key-value, checklists, diffs, and custom `tsx`) do not need this — use `runtimeShowUi` as described in your system prompt.

## UI capabilities and application lifecycle

All UI is invoked through `runtimeInvoke`; each capability is permission-gated. Exact invokable inputs (verified schemas):

- **`ui.document.open {path, idempotencyKey}`** — opens a local file (absolute path) in Marshal's editor in the shared evidence panel. This is the right way to show a document or report; do not compile TSX or generate HTML just to display a file. Optional `revealLine` scrolls to a line; optional `annotations` (`[{startLine, endLine?, tone: info|positive|warning|muted, label, detail?}]`) mark line ranges — use them to point the user at what matters in a file. `ui.document.annotate {instanceId, path, annotations?, revealLine?, idempotencyKey}` replaces the marks on an open document in place.
- **`ui.notification.show {extensionId, applicationId, title, message, idempotencyKey}`** — a notification, for meaningful events only (title ≤512 chars, message ≤16,384).
- **`ui.chat.message.post {extensionId, applicationId, content, idempotencyKey}`** — posts into the session transcript; `content` is `{kind: "text", text}` or `{kind: "markdown", markdown}` (≤16,384 chars).
- **`ui.chat.card.show {extensionId, applicationId, state?, placement?, timeoutMs?, slot?, afterMessageId?, idempotencyKey}`** — renders a published application (extension-registered, or your authored render under owner `marshal.react-ui`) as a card in the current chat. Default `placement: "transient"`; pass `placement: "card"` for a permanent conversation card (see "Where views go").
- **`ui.application.open {extensionId, applicationId, placement, state?, title?, slot?, afterMessageId?, timeoutMs?, replaceInstanceId?, idempotencyKey}`** — opens a published application (extension-registered or authored) at a placement (see "Where views go"). The legacy `surface` field (`inline-card | tab | panel | bottom-panel | floating | fullscreen`) still works. `replaceInstanceId` swaps new content into a view you already opened, keeping its id and exact placement.
- **`ui.applications.list {}`** — lists your scope's authored-render publications (owner `marshal.react-ui`, `applicationId` = renderId, plus title/description/resource/manifest) — check it before claiming an authored render is or is not placeable.
- **`ui.application.update {extensionId, applicationId, instanceId, state?, idempotencyKey}`** — updates a running instance's state.
- **`ui.application.focus` / `ui.application.close` `{extensionId, applicationId, instanceId, idempotencyKey}`** — focus brings a view to the front and also takes an optional `surface` that moves it there.
- **`ui.layout.get {}`** — every view attached to this session and where it sits right now (placement, dock group, tab index, active tab, card anchor, transient expiry, dock sizes), including moves the user made by dragging. **`ui.view.move {instanceId, placement}`** moves any view (yours or an extension's) to another placement.
- **`ui.application.list {extensionId?, applicationId?, surface?}`** — returns open instances in scope. It does **not** return user-interaction events, so never claim to know how the user interacted with your UI unless something actually reports it. Interaction IS observable through its effects: a declared action's own result inside the component, and any capability state the action writes (which you can read back). The host's isolated browser E2E harness exercises real clicks in tests — the absence of an event feed is a scoping fact about your session tools, not "UI cannot be tested".

How the pieces fit:

- **Owner identity.** `extensionId` + `applicationId` name a **published application**. Two owner families exist: applications an installed extension registered with the runtime (discover via `runtimeSearch` `ui_application` catalog entries or the extension's own listing/resources), and your own **authored renders** under the reserved owner `marshal.react-ui` with `applicationId` = the `ui.render` result id (enumerate them with `ui.applications.list`). You cannot pass free-form markup, descriptors, or render code through the open/card capabilities themselves: content must be an extension-published application or a render you actually prepared. (`ui.document.open` is the standalone exception — it takes only a path.)
- **`state`** is a plain-JSON object handed to the registered application — this is your lever for what the UI shows. Update it over the instance lifecycle rather than closing and reopening.
- **Results.** UI calls return `{ok, value: {receipt, instance?, instances?}, error?}`. The `receipt` records `{action, status: "applied"|"deduplicated", instanceId?, deliveryId?, revision, completedAt}`; an `instance` carries `{instanceId, owner, surface, content, idempotencyKey, revision, openedAt, updatedAt, focusedAt, title?, transient?, anchor?}`. Take the `instanceId` from the open result's receipt/instance and use it for update/focus/close.
- **Limits.** Active instances per session, payload size/depth, and command rates are bounded (configurable — not fixed numbers). On a limit error, close instances you no longer need or shrink the payload; don't retry unchanged.
- **Creating brand-new UI:** you can author new UI yourself — compile real TSX with `ui.compile`, prepare it with `ui.render`, then place it with these same open/card capabilities under the reserved authored owner `extensionId: "marshal.react-ui"`, `applicationId: <renderId>` (full loop in "Building custom React UI" below; enumerate your prepared renders with `ui.applications.list`). What still requires an extension is publishing a new _extension-registered_ application id of its own. Never fake UI with screenshots or prose when a real surface was requested — if a placement call fails, report exactly what failed instead of claiming the UI was shown.

(Placements — `chat-tab`, `side`, `bottom`, `floating`, `card`, `transient`, `fullscreen` — and the `slot`/`afterMessageId` rules are in the "Where views go" section of your system prompt.)

Lifecycle recipe for a registered application:

```
1. runtimeSearch {query: "…"}                          → find the ui_application entry
2. runtimeSearch {name: "ui.application.open"}          → confirm the full schema once
3. runtimeInvoke {capability: "ui.application.open",
     input: {extensionId, applicationId, placement: "side",
             state: {...initial state...}, idempotencyKey: "open-report-1"}}
                                                        → keep instanceId from the result
4. runtimeInvoke {capability: "ui.application.update",
     input: {extensionId, applicationId, instanceId,
             state: {...new state...}, idempotencyKey: "update-report-2"}}
5. ui.application.focus when you need the user's attention; ui.application.close when done.
```

## Building custom React UI (agent-authored, end to end)

You can author real React interfaces yourself — not just open pre-registered applications. The verified loop:

1. **Check the authoring profile, then write a TSX component into the workspace.** Framework imports are intrinsic to the compiler: `react`, `react-dom`, `react-dom/client`, and the JSX runtime always resolve to the runtime's bundled React (JSX uses the automatic transform) regardless of profile. Any OTHER bare package import is governed by the ACTIVE authoring profile's `packageImports` allowlist — the built-in `marshal-standards` profile allows none (custom React + standard MCP-Apps CSS variables only). Never hardcode availability: discover the live profile with `runtimeInvoke {capability: "ui.authoring.profiles.list"}` (select with `ui.authoring.profiles.select`) and read its `packageImports`, accessibility, and layout constraints before writing imports. No network, no Node built-ins, regardless of profile. The full authoring surface (discover each schema before first use; the runtime catalog, not this text, is the source of truth): `ui.authoring.profiles.list/select`, `ui.compile`, `ui.render`, `ui.renders.get/list`, `ui.components.get/list`, `ui.registered.compile/list` (optional — compiles host-REGISTERED reusable component sources; never a prerequisite for your own authored loop), `ui.applications.list`. Separately, the `ui.authored.*` family (create/read/list/update/changeState/readSnapshot/remove/migrate) manages durable scoped authored-application STATE records — writes are gated on the high-risk `ui.authored.write` permission, and in this build those records are NOT a placement or registration route: placing your UI on a surface goes only through `ui.render` → `ui.application.open` under `marshal.react-ui`. The default export is your component; when rendered with an application manifest it also receives a `marshal` prop (client API below). Type it with: `import type { MarshalUiClient, MarshalUiComponentProps } from '@marshal/agent-runtime-ui';`
2. **Compile:** `runtimeInvoke {capability: "ui.compile", input: {entryPath: "StatusPanel.tsx", title: "Triage status", description?, authoringProfile?}}` → content-addressed `component.id` (sha256).
3. **Render:** `runtimeInvoke {capability: "ui.render", input: {componentId, props, fallback: {summary}, application?}}` → `render.id` plus a per-render tool `marshal_render_react_<renderId>`. `props` is the plain-JSON input your component receives; `fallback.summary` is what users see if the interface cannot display. The optional `application` manifest unlocks interactivity:
   - exact shape: `{version: "1.0.0", presentationModes: ["inline"|"fullscreen"|"pip", …], actions: [...], tools: [...], localState?: {scope, schemaVersion}, authoritativeState?: {capability, resourceId, version}}`;
   - each action is fully declared: `{id, version, title?, target: {kind: "capability", capability} | {kind: "module", module}, inputSchema, outputSchema, allowedScopes, requiredPermissions, risk: "read"|"write"|"external-effect", idempotency: "required"|"supported"|"none"}`. A module target's default export is invoked with the action's input — a plain JSON value matching `inputSchema` (an object for object schemas) — plus the brokered context. Action `id` must match `[a-zA-Z0-9_-]+` — dots are rejected by the manifest validator. Only declared actions and tools are invokable from inside the UI — the bridge rejects everything else and checks render identity.
4. **Place it on a host surface — this is what makes it user-visible.** A render alone is _prepared_, not visible. The placement call is the host's existing open capability with the authored render's published identity:

   ```
   runtimeInvoke {capability: "ui.application.open",
     input: {extensionId: "marshal.react-ui",     // fixed owner id for authored renders
             applicationId: "<renderId>",          // the ui.render result id
             surface: "panel",                     // "inline-card" | "fullscreen" | "tab" | "panel" | "bottom-panel"
             state: { ...optional initial state... },
             idempotencyKey: "open-<renderId>"}}
   ```

   or as a chat card: `ui.chat.card.show {extensionId: "marshal.react-ui", applicationId: "<renderId>", state?, idempotencyKey}`. Keep the returned instance id and drive `ui.application.update/focus/close/list` as usual.

   The owner id `marshal.react-ui` is reserved for agent-authored renders: placement under it resolves ONLY through the authored-render projection, never through an extension's published applications. If `ui.application.open` still returns `not_found` for a renderId that `ui.renders.get {renderId}` retrieves, you are on a host build without the authored-placement bridge: say placement is unavailable in this build and fall back to registered applications or `ui.document.open` for files — never fake visibility, and never report "delivered" because a renderId exists (retrievable = prepared, placed = an open call returned an instance).

5. **Live editing:** a render compiled from a workspace file stays live — the renderer polls the file and recompiles on change; a broken edit reports `compile_failed` and keeps the last good revision. Iterate by editing the TSX.
6. **Declare viewports and verify BOTH before calling it done.** This step is for UI you author through this full loop; `runtimeShowUi` views follow the lighter rule in the section above. Declare the client viewports your UI serves in the reserved render prop `marshalViewports` (e.g. `props: {..., marshalViewports: ["mobile", "desktop"]}` on `ui.render`; the host injects `marshalViewport` with the viewing client) — undeclared UI is desktop-only and never renders on the phone. Then personally review it with `ui.observe.capture` at BOTH `viewport: "mobile"` and `viewport: "desktop"` (or drive it interactively via `ui.observe.open`'s CDP target); a UI you have not observed at a viewport is not done for that viewport.

**Inside the component (the `marshal` client):**

- `marshal.callAction(actionId, input, {scope, idempotencyKey?, approval?, signal?})` — invoke a declared action. It resolves to a `UiActionResult`: read `status` first, then take the action's payload from `result.output` (nested data arrives intact there; a `receipt` rides alongside). Never treat the resolved value itself as the payload. Key policy: a NEW user intent gets a NEW key; a retry after a failure OR a pending/granted approval reuses the ORIGINAL key (dedup + approval binding, same rule as `approval-required` above); the key clears on success. Never a fixed key — it would swallow every future click as a duplicate.
- `marshal.bindActionControl(actionId, handler)` — bind the renderer's portable chrome button for a declared action; pass the supplied `AbortSignal` into long work so Cancel and the timeout actually stop it. Returns the unbind function.
- `marshal.callTool(declaredToolId, input)` — invoke a manifest-declared tool.
- `marshal.requestDisplayMode('inline'|'fullscreen'|'pip')` — typed result `granted | unsupported | denied | fallback | timed_out`; handle it and keep the full workflow usable inline.
- `marshal.subscribe(listener)` — host-context changes (display mode, container size).

**Persistent state:** declare `localState: {scope, schemaVersion}` and the UI's string key-values persist per scope, mutated through the state tool (`set`/`remove`/`clear`, optimistic `expectedVersion`). `authoritativeState` points at a capability-owned record when the data has a real owner.

**Sandbox truth (never promise otherwise):** authored code runs in a network-denied, `allow-scripts` sandboxed iframe behind a strict CSP; its only effect channel is the bounded bridge — declared actions/tools carrying the render's own identity. It cannot read files, call capabilities directly, or reach other UI.

## Two different "surface" vocabularies — never conflate them

- **Host placements** — `chat-tab | side | bottom | floating | card | transient | fullscreen` (legacy surfaces `tab | panel | bottom-panel | floating | inline-card | fullscreen`) — are where the HOST puts a UI instance (`ui.application.open {placement}`). Host capability vocabulary.
- **Renderer display modes** — `inline | fullscreen | pip` — are what a React application manifest declares in `presentationModes` and what `marshal.requestDisplayMode` negotiates INSIDE an already-placed instance; the renderer offers portable chrome for declared non-inline modes and the host may grant, deny, or fall back.

## Composing capabilities with brokered TypeScript

The two ambient methods are exactly `context.runtime.search(query)` and `context.runtime.invoke(capability, input)`; **no idempotency parameter exists at this layer** — keys live only where a capability's own input schema declares them (host `ui.*` capabilities declare `idempotencyKey` inside their input, next to the owner fields).

A complete worked example — inspect-before-invoke, strict validation, mid-work notifications, UI prepare + honest delivery status, structured partial/failure results. Pass this (adapted) as `runtimeExecuteTypeScript`'s `source`, or save to the workspace for `runtimeExecuteModule`:

```ts
interface TriageInput {
  runKey: string;
  listCapability: string; // the data capability — supplied, never guessed
  componentId?: string; // a previously ui.compile'd component
  notifyOwner?: { extensionId: string; applicationId: string };
}

export default async (input: TriageInput, context) => {
  const notifications = { sent: 0, failed: 0 };
  const notify = async (message: string, tag: string) => {
    if (!input.notifyOwner) return;
    try {
      // Host capability; idempotencyKey INSIDE the input per its schema.
      await context.runtime.invoke("ui.notification.show", {
        ...input.notifyOwner,
        title: "Triage report",
        message,
        idempotencyKey: `triage-${input.runKey}-${tag}`,
      });
      notifications.sent += 1;
    } catch {
      notifications.failed += 1; // progress signal, never fatal
    }
  };

  // 1. Inspect the FULL descriptor before the first invoke — exact-name
  //    lookup returns full schemas; a ranked match is never accepted blindly.
  const lookup = await context.runtime.search({ name: input.listCapability });
  const descriptor = lookup?.matches?.find(
    (m) => m.capability?.name === input.listCapability,
  )?.capability;
  if (!descriptor) {
    return {
      status: "failed",
      stage: "discovery",
      error: `Capability "${input.listCapability}" not found by exact-name search.`,
    };
  }
  const outputProps = descriptor.outputSchema?.properties ?? {};
  if (!("items" in outputProps)) {
    return {
      status: "failed",
      stage: "discovery",
      error: `"${input.listCapability}" does not declare an items output; refusing to guess.`,
    };
  }

  // 2. Fetch and STRICTLY validate — invalid data is a failure, never [].
  const raw = await context.runtime.invoke(input.listCapability, { limit: 50 });
  if (!Array.isArray(raw?.items)) {
    return {
      status: "failed",
      stage: "fetch",
      error: `"${input.listCapability}" returned no items array.`,
      notifications,
    };
  }
  const items = [],
    invalid = [];
  for (const item of raw.items) {
    (typeof item?.id === "string" && typeof item?.severity === "string" ? items : invalid).push(
      item,
    );
  }
  await notify(`Fetched ${items.length} items; classifying…`, "fetched");

  // 3. Transform: group by severity, bounded samples.
  const grouped = new Map();
  for (const item of items) {
    (grouped.get(item.severity) ?? grouped.set(item.severity, []).get(item.severity)).push(item.id);
  }
  const summary = [...grouped.entries()]
    .sort()
    .map(([severity, ids]) => ({ severity, count: ids.length, ids: ids.slice(0, 5) }));

  // 4. Prepare the UI; verify retrievability; report honestly. Visibility
  //    needs the host placement step (ui.application.open — see above),
  //    which is a separate, surface-placing call.
  let ui = { status: "skipped" };
  if (input.componentId) {
    try {
      const rendered = await context.runtime.invoke("ui.render", {
        componentId: input.componentId,
        props: { summary, generatedAt: `run ${input.runKey}` },
        fallback: { summary: `Triage: ${items.length} open items` },
      });
      const renderId = rendered?.render?.id;
      if (!renderId) throw new Error("ui.render returned no render id.");
      await context.runtime.invoke("ui.renders.get", { renderId }); // retrievable = prepared
      ui = {
        status: "prepared",
        renderId,
        delivery:
          'Place with ui.application.open {extensionId:"marshal.react-ui", applicationId:renderId, surface}.',
      };
    } catch (error) {
      ui = { status: "failed", error: String(error?.message ?? error) };
      await notify(`Render failed: ${ui.error}`, "render-failed");
    }
  }

  await notify(
    `Triage ${ui.status === "failed" ? "partially " : ""}complete: ` +
      `${items.length} items across ${summary.length} severities.`,
    "complete",
  );
  return {
    status: ui.status === "failed" || invalid.length > 0 ? "partial" : "complete",
    itemCount: items.length,
    invalidItemCount: invalid.length,
    summary,
    ui,
    notifications,
  };
};
```

The rules this encodes, in force for every script: inspect the full descriptor before the first invoke of anything unfamiliar; treat responses that don't match the declared shape as structured failures (`{status, stage, error}`), never silent empty successes; degrade optional steps (notifications, rendering) with the outcome recorded and return `"partial"` when a requested step failed; report UI as `prepared` until a placement call actually ran. For durable logic, save the module in the workspace and run it via `runtimeExecuteModule {module: {kind: "workspace_file", path}}`.
