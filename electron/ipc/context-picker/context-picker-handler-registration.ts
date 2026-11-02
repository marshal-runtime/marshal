// Owns context-picker IPC handler registration.
import type { ContextEntityType } from "../../../common/marshal-ipc-contract";
import { createLogger } from "../../../common/marshal-logger";
import type { IpcDeps } from "../types";
import { errorMessage, resolveEntityTypes } from "./internals";
import { searchAllTypes } from "./search";
import type { RuntimePeopleSearch } from "./search";

const log = createLogger("ContextPickerIpc");

export function registerContextPickerHandlers(
  { ipcHandle }: Pick<IpcDeps, "ipcHandle">,
  options: { readonly runtimePeopleSearch?: RuntimePeopleSearch } = {},
) {
  ipcHandle(
    "contextPicker:search",
    async (_event, query: string, entityTypes?: ContextEntityType[]) => {
      try {
        const types = resolveEntityTypes(entityTypes);
        const entities = await searchAllTypes(query, types, options.runtimePeopleSearch);
        return { success: true, entities };
      } catch (error) {
        log.error("Search failed:", error);
        return { success: false, error: errorMessage(error) };
      }
    },
  );
}
