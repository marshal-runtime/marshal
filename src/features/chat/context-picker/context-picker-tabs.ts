/**
 * Tab definitions for the Context Picker. Tabs are a projection of the
 * registered context sources (`context-sources.ts`) — a new source shows up as
 * a tab without touching this file. Lives in its own module so the
 * `ContextPickerMenu.tsx` component file only exports components
 * (Fast Refresh / `only-export-components` lint rule).
 */

import {
  CONTEXT_SOURCE_PROVIDERS,
  getVisibleContextSources,
  type ContextSourceProvider,
} from "./context-sources";

export type TabId = ContextSourceProvider["id"];

export interface PickerTab {
  id: TabId;
  label: string;
}

function toTab(source: ContextSourceProvider): PickerTab {
  return { id: source.id, label: source.label };
}

/** Type guard for narrowing the `string` value Radix Tabs hands back to a TabId. */
export function isTabId(value: string): value is TabId {
  return CONTEXT_SOURCE_PROVIDERS.some((source) => source.id === value);
}

/**
 * Compute the visible tabs given trigger context.
 * Slash shows only Marshal and workspace-provided commands/skills. Entity
 * sources remain available through their dedicated triggers (for example @).
 */
export function getVisibleTabs(isStartSlash: boolean): PickerTab[] {
  return getVisibleContextSources(isStartSlash).map(toTab);
}
