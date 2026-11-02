/**
 * First-party slot registrations — the single wiring point for 1P extensions.
 *
 * This file is imported once at app startup (`src/main.tsx`) before the first
 * render. Call `extensionClient.register(manifest)` for each 1P extension.
 * All contributions are declarative and gated by `activateWhen` in the manifest;
 * no explicit per-session activation is needed.
 *
 * ── Workflow Run renderers (Dynamic Workflows V1) ───────────────────────────
 *
 * Custom per-workflow renderers contribute to `SLOT.WORKFLOW_RUN_DETAIL` and
 * activate when `ctx.workflowId === "<their workflow id>"`. When no
 * contribution matches, `<SlotRenderer>` falls back to the built-in
 * 3-column `DefaultRunRenderer` in `src/features/workflows/`.
 *
 * Workflow renderers are loaded through the workflow bundle APIs instead of
 * hard-coded first-party slot registrations.
 *
 * ── Adding a new 1P extension ────────────────────────────────────────────────
 *
 * 1. Create your extension under `src/plugins/<name>/`.
 *
 * 2. Export an `Extension1PManifest` from its `manifest.ts`:
 *
 *    ```ts
 *    // src/plugins/people/manifest.ts
 *    import { SLOT } from "@/extensions";
 *    import type { Extension1PManifest } from "@/extensions";
 *    import { PersonEditor } from "./PersonEditor";
 *
 *    export const peopleManifest: Extension1PManifest = {
 *      id: "com.example.people",
 *      displayName: "People",
 *      contributes: {
 *        slots: [
 *          {
 *            slotId: SLOT.CREATE_EDITOR,
 *            component: PersonEditor,
 *            activateWhen: ({ activeFileType }) =>
 *              activeFileType === "com.example.people.person",
 *          },
 *        ],
 *      },
 *    };
 *    ```
 *
 * 3. Register it here:
 *
 *    ```ts
 *    import { peopleManifest } from "../plugins/people/manifest";
 *    extensionClient.register(peopleManifest);
 *    ```
 *
 * Components receive `{ ctx: SlotContext, api: ExtensionAPI }` as props.
 * The `api` object is the ONLY sanctioned way to reach Electron — no `window.*`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
