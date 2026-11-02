import {
  EXTENSIONS_CATALOG,
  type CatalogItem,
  type ExtensionsCategory as PluginsCategory,
} from "@common/extensions-catalog/marshal-extension-catalog";
import type {
  RuntimeExtensionProjectedStatusItem,
  RuntimeExtensionsScope,
  RuntimeExtensionsStatusSnapshot,
} from "@common/marshal-ipc-contract";
import type {
  RuntimeExtensionCatalogEntry,
  RuntimeExtensionCatalogSearchMatch,
} from "@marshal/runtime/extensions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import { useMcpServers } from "@/shared/hooks/useMcpServerCatalog";
import { useSkills } from "@/shared/hooks/useSkillCatalog";

import { parseCatalogContent } from "./parseCatalogContent";
import { uniqueByKey } from "./plugin-deduplication";
import type { InstallState } from "./PluginsCard";

export type { PluginsCategory };

interface UsePluginsDataParams {
  isOpen: boolean;
  search: string;
  installingIds: Set<string>;
  runtimeScope?: RuntimeExtensionsScope;
}

function runtimeStatusMatchesSearch(
  item: RuntimeExtensionProjectedStatusItem,
  query: string,
): boolean {
  const searchable = [
    item.identity,
    item.version,
    item.packageRoot,
    item.candidateId,
    item.installation?.packageManager,
    item.installation?.script,
    ...item.diagnostics.flatMap((diagnostic) => [
      diagnostic.code,
      diagnostic.path,
      diagnostic.message,
    ]),
  ];
  return searchable.some((value) => value?.toLowerCase().includes(query));
}

export function usePluginsData({
  isOpen,
  search,
  installingIds,
  runtimeScope,
}: UsePluginsDataParams) {
  const queryClient = useQueryClient();
  // --- Data fetching ---
  const { data: installedSkills = [] } = useSkills(isOpen);
  const catalogQuery = useQuery({
    queryKey: ["runtime-extensions", "catalog", runtimeScope, search],
    enabled: isOpen && !!runtimeScope?.sessionId && !!runtimeScope?.workspaceName,
    queryFn: async (): Promise<readonly RuntimeExtensionCatalogEntry[]> => {
      if (!runtimeScope || !window.runtimeExtensionsAPI) return [];
      const result = await window.runtimeExtensionsAPI.search({
        ...runtimeScope,
        search: search.trim() ? { query: search.trim() } : {},
      });
      if (!result.success) throw new Error(result.error);
      return result.value.matches.map((match: RuntimeExtensionCatalogSearchMatch) => match.entry);
    },
    staleTime: 30_000,
    refetchOnMount: "always",
  });
  const statusQuery = useQuery({
    queryKey: ["runtime-extensions", "status", runtimeScope],
    enabled: isOpen && !!runtimeScope?.sessionId && !!runtimeScope?.workspaceName,
    queryFn: async (): Promise<RuntimeExtensionsStatusSnapshot | undefined> => {
      if (!runtimeScope || !window.runtimeExtensionsAPI) return undefined;
      const result = await window.runtimeExtensionsAPI.status(runtimeScope);
      if (!result.success) throw new Error(result.error);
      return result.value;
    },
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (!isOpen || !runtimeScope || !window.runtimeExtensionsAPI) return undefined;
    return window.runtimeExtensionsAPI.onChanged((event) => {
      if (event.sessionId && event.sessionId !== runtimeScope.sessionId) return;
      if (event.workspaceName && event.workspaceName !== runtimeScope.workspaceName) return;
      void queryClient.invalidateQueries({
        queryKey: ["runtime-extensions", "status", runtimeScope],
      });
      void queryClient.invalidateQueries({
        queryKey: ["runtime-extensions", "catalog", runtimeScope],
      });
    });
  }, [isOpen, queryClient, runtimeScope]);

  // --- Derived state ---

  const visibleCatalog = useMemo<readonly CatalogItem[]>(
    () => uniqueByKey(EXTENSIONS_CATALOG, (item) => `${item.type}:${item.name}`),
    [],
  );

  // Catalog items already have cards; keep them out of the custom sections.
  const catalogItemKeys = useMemo(() => {
    const names = new Set<string>();
    for (const item of visibleCatalog) {
      names.add(`${item.type}:${item.name}`);
    }
    return names;
  }, [visibleCatalog]);

  const customSkills = useMemo(
    () =>
      uniqueByKey(
        installedSkills.filter(
          (s: { name: string; scope: string }) =>
            s.scope !== "bundled" && !catalogItemKeys.has(`skills:${s.name}`),
        ),
        (skill) => skill.id,
      ),
    [installedSkills, catalogItemKeys],
  );

  const { data: mcpServerInfos = [] } = useMcpServers(isOpen);

  const allMcpServers = useMemo(
    () => mcpServerInfos.filter((s) => !s.builtin && s.config).map((s) => s.config!),
    [mcpServerInfos],
  );

  const customMcpServerInfos = useMemo(
    () =>
      uniqueByKey(
        mcpServerInfos.filter((s) => {
          if (s.builtin) return false;
          const name = s.config?.name ?? s.name;
          return (s.config || s.status) && !catalogItemKeys.has(`mcp-servers:${name}`);
        }),
        (server) => server.config?.name ?? server.name,
      ),
    [mcpServerInfos, catalogItemKeys],
  );

  const customMcpServers = useMemo(
    () =>
      allMcpServers.filter((s: { name: string }) => !catalogItemKeys.has(`mcp-servers:${s.name}`)),
    [allMcpServers, catalogItemKeys],
  );

  // All catalog items per category
  const catalogSkills = useMemo(
    () => visibleCatalog.filter((i) => i.type === "skills"),
    [visibleCatalog],
  );
  const catalogMcpServers = useMemo(
    () => visibleCatalog.filter((i) => i.type === "mcp-servers"),
    [visibleCatalog],
  );

  // Compute install state for a catalog item
  const getInstallState = useCallback(
    (item: CatalogItem): InstallState => {
      if (installingIds.has(item.id)) return "installing";
      if (item.source.type === "bundled") return "built-in";
      if (item.type === "skills") {
        return installedSkills.some((s: { name: string }) => s.name === item.name)
          ? "installed"
          : "available";
      }
      if (item.type === "mcp-servers") {
        const server = allMcpServers.find((s: { name: string }) => s.name === item.name);
        if (!server) return "available";
        if (item.configParams?.some((p) => p.required)) {
          const serverArgs: string[] =
            "args" in server && Array.isArray(server.args) ? server.args.map(String) : [];
          const baseDef = parseCatalogContent(item.source);
          const baseArgCount = baseDef?.args?.length ?? 0;
          const hasConfig = serverArgs.length > baseArgCount;
          if (!hasConfig) return "needs-config";
        }
        return "installed";
      }
      return "available";
    },
    [installingIds, installedSkills, allMcpServers],
  );

  const matchesSearch = useCallback(
    (name: string, description?: string) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return name.toLowerCase().includes(q) || (description?.toLowerCase().includes(q) ?? false);
    },
    [search],
  );

  const filteredCustomSkills = useMemo(
    () =>
      customSkills.filter((s: { name: string; description: string }) =>
        matchesSearch(s.name, s.description),
      ),
    [customSkills, matchesSearch],
  );

  const filteredMcpServers = useMemo(
    () =>
      customMcpServerInfos.filter((s) => {
        const config = s.config;
        const description = config && ("url" in config ? config.url : config.command);
        return matchesSearch(config?.name ?? s.name, description);
      }),
    [customMcpServerInfos, matchesSearch],
  );

  const filteredCatalogSkills = useMemo(
    () => catalogSkills.filter((i) => matchesSearch(i.displayName, i.description)),
    [catalogSkills, matchesSearch],
  );
  const filteredCatalogMcpServers = useMemo(
    () => catalogMcpServers.filter((i) => matchesSearch(i.displayName, i.description)),
    [catalogMcpServers, matchesSearch],
  );
  const runtimeCatalog = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data]);
  const runtimeStatus = useMemo(() => {
    const snapshot = statusQuery.data;
    const query = search.trim().toLowerCase();
    if (!snapshot || !query) return snapshot;
    const visibleCatalogEntryIds = new Set(runtimeCatalog.map((entry) => entry.id));
    return {
      ...snapshot,
      items: snapshot.items.filter((item) =>
        item.catalogEntryId
          ? visibleCatalogEntryIds.has(item.catalogEntryId)
          : runtimeStatusMatchesSearch(item, query),
      ),
    };
  }, [runtimeCatalog, search, statusQuery.data]);

  return {
    runtimeCatalog,
    runtimeStatus,
    runtimeCatalogLoading: catalogQuery.isLoading,
    runtimeCatalogError: catalogQuery.error ?? statusQuery.error,
    installedSkills,
    customSkills,
    allMcpServers,
    customMcpServers,
    customMcpServerInfos,
    catalogSkills,
    catalogMcpServers,
    getInstallState,
    filteredCustomSkills,
    filteredMcpServers,
    filteredCatalogSkills,
    filteredCatalogMcpServers,
  };
}
