export type { CatalogItem, CatalogConfigParam, ExtensionsCategory } from "./contracts/types";

import type { CatalogItem } from "./contracts/types";
import { SKILL_ITEMS } from "./items/marshal-skills";

export const EXTENSIONS_CATALOG: CatalogItem[] = [...SKILL_ITEMS];
