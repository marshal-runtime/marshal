import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";
import { sortModels } from "@/runtime-ui/models/sort-models";
import { groupModelsByRuntime } from "@/shared/utils/model-groups";
import type { ModelInfo } from "@/types/electron";

/** Select items for a model list, under a heading per runtime account once models span several. */
export function ModelSelectItems({ models }: { models: ModelInfo[] }) {
  const groups = groupModelsByRuntime(models);
  return groups.map((group) => (
    <SelectGroup key={group.key}>
      {groups.length > 1 && group.label && <SelectLabel>{group.label}</SelectLabel>}
      {sortModels(group.models).map((model) => (
        <SelectItem key={model.id} value={model.id}>
          {model.name || model.id}
        </SelectItem>
      ))}
    </SelectGroup>
  ));
}
