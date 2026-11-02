/**
 * Public extension API.
 *
 * Import from `@/extensions` (not from submodules directly).
 *
 * ── Quick start for a 1P slot extension ──────────────────────────────────────
 *
 * // 1. Write a typed slot component — use `props.api` for all Electron access.
 * ```tsx
 * import type { SlotProps } from "@/extensions";
 *
 * export function PersonEditor({ ctx, api }: SlotProps) {
 *   return (
 *     <button
 *       onClick={() => api.chat.send(`Summarize ${ctx.activeFile}`, ctx.sessionId ?? undefined)}
 *     >
 *       Ask AI
 *     </button>
 *   );
 * }
 * ```
 *
 * // 2. Declare a manifest with the slots the extension contributes.
 * ```ts
 * import { SLOT } from "@/extensions";
 * import type { Extension1PManifest } from "@/extensions";
 * import { PersonEditor } from "./PersonEditor";
 *
 * export const peopleManifest: Extension1PManifest = {
 *   id: "com.example.people",
 *   displayName: "People",
 *   contributes: {
 *     slots: [
 *       {
 *         slotId: SLOT.CREATE_EDITOR,
 *         component: PersonEditor,
 *         activateWhen: ({ activeFileType }) =>
 *           activeFileType === "com.example.people.person",
 *       },
 *     ],
 *   },
 * };
 * ```
 *
 * // 3. Register once, before the first render, in `registered.ts`:
 * ```ts
 * import { extensionClient } from "@/extensions";
 * import { peopleManifest } from "../features/people/manifest";
 * extensionClient.register(peopleManifest);
 * ```
 */

// Slot IDs
export { SLOT, SLOT_LABEL } from "./slot-ids";
export type { SlotId } from "./slot-ids";

// Extension capability type (do not access window.* directly in slot components)
export type { ExtensionAPI } from "./extension-contracts";

// Registry — low-level. Prefer extensionClient.register() over registry.contribute() directly.
export { registry, useRegistryVersion } from "./registry";
export type { SlotContext, SlotProps, SlotContribution } from "./registry";
export type {
  SlotContextBase,
  CreatePanelSlotContext as CreateSlotContextBase,
  CreatePanelPrimarySidebarContext as PrimarySidebarContext,
  CreatePanelTreeNodeIconContext,
  SlotContextMap,
} from "./slot-ids";

// Extension client — the entry point for registering 1P extensions.
export { extensionClient, useExtensions } from "./extension-client";
export type { Extension1PManifest } from "./extension-client";

// Slot renderer
export { SlotRenderer } from "./MarshalSlotRenderer";
