import type { MemoryCategory, MemoryEntry } from "@common/marshal-ipc-contract";

import { createLogger } from "../../../common/marshal-logger";
import type {
  IMemoryStore,
  MemoryPromptSelection,
  MemoryPromptSelectionRequest,
} from "../../backend/ports";
import { memoryAppliesToProject } from "./memory-scoping";
import {
  isRenderableMemoryEntry,
  renderMemoryEntriesForPrompt,
  renderMemoryPromptLine,
} from "./prompt-provenance";

const log = createLogger("MemoryPromptSelection");

export const DEFAULT_MEMORY_PROMPT_BUDGET_BYTES = 8192;

const CATEGORY_PRIORITY: readonly MemoryCategory[] = ["preference", "decision", "fact", "context"];

function categoryRank(category: MemoryCategory): number {
  const rank = CATEGORY_PRIORITY.indexOf(category);
  return rank === -1 ? CATEGORY_PRIORITY.length : rank;
}

function createdAtMs(entry: MemoryEntry): number {
  const ms = typeof entry.createdAt === "string" ? Date.parse(entry.createdAt) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

export function resolveMemoryPromptRequest(
  request?: Partial<MemoryPromptSelectionRequest>,
): MemoryPromptSelectionRequest {
  const budget = request?.budgetBytes;
  return {
    ...request,
    budgetBytes:
      typeof budget === "number" && Number.isFinite(budget) && budget >= 0
        ? budget
        : DEFAULT_MEMORY_PROMPT_BUDGET_BYTES,
  };
}

/**
 * Host fallback for providers without `selectForPrompt`. A line's cost is the
 * UTF-8 byte length of `renderMemoryPromptLine(entry)` without its newline.
 */
export function selectMemoriesForPrompt(
  entries: readonly MemoryEntry[],
  request: MemoryPromptSelectionRequest,
): MemoryPromptSelection {
  const ordered = entries
    .filter(isRenderableMemoryEntry)
    .filter((entry) => memoryAppliesToProject(entry, request.projectId))
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        categoryRank(left.entry.category) - categoryRank(right.entry.category) ||
        createdAtMs(right.entry) - createdAtMs(left.entry) ||
        left.index - right.index,
    );
  const selected: MemoryEntry[] = [];
  let usedBytes = 0;
  let omitted = 0;
  for (const { entry } of ordered) {
    const lineBytes = Buffer.byteLength(renderMemoryPromptLine(entry), "utf8");
    if (usedBytes + lineBytes > request.budgetBytes) {
      omitted += 1;
      continue;
    }
    usedBytes += lineBytes;
    selected.push(entry);
  }
  return { entries: selected, omitted: { count: omitted } };
}

function isValidSelection(value: unknown): value is MemoryPromptSelection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MemoryPromptSelection>;
  return (
    Array.isArray(candidate.entries) &&
    typeof candidate.omitted?.count === "number" &&
    Number.isFinite(candidate.omitted.count) &&
    candidate.omitted.count >= 0
  );
}

export function selectMemoriesForPromptFromStore(
  store: IMemoryStore,
  request?: Partial<MemoryPromptSelectionRequest>,
): MemoryPromptSelection {
  const resolved = resolveMemoryPromptRequest(request);
  if (typeof store.selectForPrompt === "function") {
    try {
      const selection: unknown = store.selectForPrompt(resolved);
      if (isValidSelection(selection)) return selection;
      log.warn("Memory provider returned an invalid prompt selection; using host fallback");
    } catch (error) {
      log.warn("Memory provider prompt selection failed; using host fallback", {
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return selectMemoriesForPrompt(store.list(), resolved);
}

export function formatMemoryPromptFromStore(
  store: IMemoryStore,
  request?: Partial<MemoryPromptSelectionRequest>,
): string {
  try {
    const selection = selectMemoriesForPromptFromStore(store, request);
    return renderMemoryEntriesForPrompt(selection.entries, {
      omittedCount: selection.omitted.count,
    });
  } catch (error) {
    log.warn("Memory prompt could not be built; continuing without a memory block", {
      error: error instanceof Error ? error.name : typeof error,
    });
    return "";
  }
}
