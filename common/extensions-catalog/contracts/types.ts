export type ExtensionsCategory = "skills" | "mcp-servers" | "ui-extensions";

type CatalogSource =
  | { type: "bundled" }
  | { type: "first-party"; content: string }
  | { type: "github"; repo: string; path: string }
  | { type: "url"; url: string };

export interface CatalogConfigParam {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  displayName: string;
  type: ExtensionsCategory;
  description: string;
  author: string;
  icon: string;
  tags: string[];
  source: CatalogSource;
  configParams?: CatalogConfigParam[];
}
