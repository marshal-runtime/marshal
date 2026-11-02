import type { ModelInfo } from "@/types/electron";

export interface ModelGroup {
  key: string;
  label?: string;
  models: ModelInfo[];
}

/** Groups by runtime account in first-appearance order; the backend lists the active runtime first. */
export function groupModelsByRuntime(models: ModelInfo[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    const key = model.runtime ? `${model.runtime.runtimeId}@${model.runtime.accountId ?? ""}` : "";
    const group = groups.get(key) ?? { key, label: model.runtime?.label, models: [] };
    group.models.push(model);
    groups.set(key, group);
  }
  return [...groups.values()];
}
