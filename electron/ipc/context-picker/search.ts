/** Context Picker search orchestration. */

import type {
  ContextEntity,
  ContextEntityType,
  ContextPersonEntity,
} from "../../../common/marshal-ipc-contract";
import { createLogger } from "../../../common/marshal-logger";

const log = createLogger("ContextPickerSearch");

export type RuntimePeopleSearch = (
  query: string,
) => Promise<readonly ContextPersonEntity[] | undefined>;

async function fetchPeople(query: string, runtimePeopleSearch?: RuntimePeopleSearch) {
  if (!runtimePeopleSearch) return [];
  try {
    return (await runtimePeopleSearch(query)) ?? [];
  } catch (err) {
    log.warn("Runtime people fetch failed:", err);
    return [];
  }
}

/**
 * People come from runtime extensions that publish a people directory. Local
 * workspace files are served by the workspace IPC, so this search returns no
 * File entities of its own.
 */
async function searchAllTypes(
  query: string,
  types: ReadonlySet<ContextEntityType>,
  runtimePeopleSearch?: RuntimePeopleSearch,
): Promise<ContextEntity[]> {
  const people = types.has("People") ? await fetchPeople(query, runtimePeopleSearch) : [];
  log.info(`searchAllTypes results: people=${people.length}`);
  return [...people];
}

export { searchAllTypes };
