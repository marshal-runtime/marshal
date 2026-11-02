import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";
import type { SanitizationWarning } from "@common/foundation/skills/skill-sanitization";
import type { RuntimeExtensionsScope } from "@common/marshal-ipc-contract";
import {
  SKILL_IMPORT_DISMISSED,
  type AddMcpServerInput,
  type McpServerInfo,
} from "@common/marshal-ipc-contract";
import type {
  RuntimeExtensionCatalogEntry,
  RuntimeExtensionContractConflict,
} from "@marshal/runtime/extensions";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import { useState, useCallback } from "react";

import type { Skill } from "@/types/electron";

import { parseCatalogContent } from "./parseCatalogContent";

/** Append a content-safety warning suffix to a success message when warnings are present. */
function withSafetyWarning(message: string, warnings?: SanitizationWarning[]): string {
  if (!warnings?.length) return message;
  return `${message} — warning: content contains special formatting that may interfere with AI processing`;
}

function requireContractConflict(
  conflict: RuntimeExtensionContractConflict | undefined,
): RuntimeExtensionContractConflict {
  if (!conflict) {
    throw new Error("Runtime contract-conflict repair details are unavailable.");
  }
  return conflict;
}

interface UsePluginsActionsOptions {
  queryClient: QueryClient;
  installedSkills: ReturnType<typeof import("./usePluginsData").usePluginsData>["installedSkills"];
  allMcpServers: ReturnType<typeof import("./usePluginsData").usePluginsData>["allMcpServers"];
  setInstallingIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  runtimeScope?: RuntimeExtensionsScope;
}

export function usePluginsActions({
  queryClient,
  installedSkills,
  allMcpServers,
  setInstallingIds,
  runtimeScope,
}: UsePluginsActionsOptions) {
  // Unified status message — set by mutation callbacks, replaces importError/importSuccess
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const clearStatus = useCallback(() => setStatus(null), []);
  const invalidateRuntime = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["runtime-extensions", "catalog"] }),
        queryClient.invalidateQueries({ queryKey: ["runtime-extensions", "status"] }),
        queryClient.invalidateQueries({ queryKey: ["runtime-ui", "applications"] }),
        queryClient.invalidateQueries({ queryKey: ["runtime-ui", "placements"] }),
      ]),
    [queryClient],
  );

  const runtimeMutation = useMutation({
    mutationFn: async ({
      action,
      entry,
      provider,
      configuration,
      serviceId,
      packageRoot,
      conflict,
    }: {
      action:
        | "install"
        | "update"
        | "updateFromDirectory"
        | "enable"
        | "disable"
        | "configure"
        | "setProvider"
        | "clearProvider"
        | "repairContractConflict"
        | "remove";
      entry: RuntimeExtensionCatalogEntry;
      provider?: string;
      configuration?: Readonly<Record<string, unknown>>;
      serviceId?: string;
      packageRoot?: string;
      conflict?: RuntimeExtensionContractConflict;
    }) => {
      if (!runtimeScope || !window.runtimeExtensionsAPI) {
        throw new Error(
          "Runtime extensions are unavailable for this session. Reopen the session or select a runtime-enabled workspace.",
        );
      }
      if (action === "setProvider" && !provider) {
        throw new Error("A provider is required to select a runtime provider.");
      }
      if ((action === "setProvider" || action === "clearProvider") && !serviceId) {
        throw new Error("A service is required to select or clear a runtime provider.");
      }
      if (action === "updateFromDirectory" && !packageRoot) {
        throw new Error("A local extension directory is required for this update.");
      }
      const runtimeServiceId = serviceId ?? "";
      const base = { ...runtimeScope };
      const result =
        action === "install"
          ? await window.runtimeExtensionsAPI.install({ ...base, catalogEntryId: entry.id })
          : action === "update"
            ? await window.runtimeExtensionsAPI.update({
                ...base,
                identity: entry.identity,
                catalogEntryId: entry.id,
              })
            : action === "updateFromDirectory"
              ? await window.runtimeExtensionsAPI.update({
                  ...base,
                  identity: entry.identity,
                  packageRoot: packageRoot ?? "",
                })
              : action === "enable"
                ? await window.runtimeExtensionsAPI.enable({ ...base, identity: entry.identity })
                : action === "disable"
                  ? await window.runtimeExtensionsAPI.disable({ ...base, identity: entry.identity })
                  : action === "configure"
                    ? await window.runtimeExtensionsAPI.configure({
                        ...base,
                        identity: entry.identity,
                        configuration: configuration ?? entry.installation?.configuration ?? {},
                      })
                    : action === "setProvider"
                      ? await window.runtimeExtensionsAPI.setProvider({
                          ...base,
                          identity: entry.identity,
                          serviceId: runtimeServiceId,
                          providerId: provider,
                        })
                      : action === "clearProvider"
                        ? await window.runtimeExtensionsAPI.clearProvider({
                            ...base,
                            identity: entry.identity,
                            serviceId: runtimeServiceId,
                          })
                        : action === "repairContractConflict"
                          ? await window.runtimeExtensionsAPI.repairContractConflict({
                              ...base,
                              request: requireContractConflict(conflict).request,
                            })
                          : await window.runtimeExtensionsAPI.remove({
                              ...base,
                              identity: entry.identity,
                            });
      if (!result.success) throw new Error(result.error);
      return result;
    },
    onError: (error) => setStatus({ type: "error", message: String(error) }),
    onSettled: () => void invalidateRuntime(),
  });

  const runtimeLocalInstallMutation = useMutation({
    mutationFn: async (packageRoot: string) => {
      if (!runtimeScope || !window.runtimeExtensionsAPI) {
        throw new Error(
          "Runtime extensions are unavailable for this session. Reopen the session or select a runtime-enabled workspace.",
        );
      }
      const result = await window.runtimeExtensionsAPI.installLocal({
        ...runtimeScope,
        packageRoot,
      });
      if (!result.success) throw new Error(result.error);
      return result.value;
    },
    onSuccess: (record) => {
      setStatus({ type: "success", message: `Installed Runtime extension "${record.identity}"` });
    },
    onError: (error) => setStatus({ type: "error", message: String(error) }),
    onSettled: () => void invalidateRuntime(),
  });

  const runRuntimeMutation = useCallback(
    (
      action:
        | "install"
        | "update"
        | "updateFromDirectory"
        | "enable"
        | "disable"
        | "configure"
        | "setProvider"
        | "clearProvider"
        | "repairContractConflict"
        | "remove",
      entry: RuntimeExtensionCatalogEntry,
      provider?: string,
      configuration?: Readonly<Record<string, unknown>>,
      serviceId?: string,
      packageRoot?: string,
      conflict?: RuntimeExtensionContractConflict,
    ) => {
      setStatus(null);
      if (action === "setProvider" && !provider) {
        setStatus({
          type: "error",
          message: "A provider is required to select a runtime provider.",
        });
        return;
      }
      runtimeMutation.mutate({
        action,
        entry,
        provider,
        configuration,
        serviceId,
        packageRoot,
        conflict,
      });
    },
    [runtimeMutation],
  );

  // Skill dialog state
  const [showImport, setShowImport] = useState(false);
  const [showAddSkill, setShowAddSkill] = useState(false);
  const [editingSkill, setEditingSkill] = useState<{
    name: string;
    displayName: string;
    description: string;
    instructions: string;
  } | null>(null);

  // MCP add form state
  const [addingMcp, setAddingMcp] = useState(false);
  const [newMcpName, setNewMcpName] = useState("");
  const [newMcpUrl, setNewMcpUrl] = useState("");
  const [newMcpMode, setNewMcpMode] = useState<"url" | "command">("url");
  const [newMcpCommand, setNewMcpCommand] = useState("");
  const [newMcpBearerToken, setNewMcpBearerToken] = useState("");
  const [newMcpTimeoutSeconds, setNewMcpTimeoutSeconds] = useState("");
  const [newMcpTransport, setNewMcpTransport] = useState<"http" | "sse">("http");
  const [newMcpEnvFile, setNewMcpEnvFile] = useState("");

  // ── Skill mutations ─────────────────────────────────────────────────────

  const importSkillUrlMutation = useMutation({
    mutationFn: async (url: string) => {
      const result = await window.skillsAPI?.importUrl(url);
      if (!result?.success) throw new Error(result?.error ?? "Import failed");
      return result;
    },
    onSuccess: (result) => {
      setStatus({
        type: "success",
        message: withSafetyWarning(
          `Imported skill "${result.skill?.name ?? "unknown"}"`,
          result.warnings,
        ),
      });
    },
    onError: (err) => setStatus({ type: "error", message: String(err) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });

  const importSkillBundleMutation = useMutation({
    mutationFn: async (dirPath?: string) => {
      const result = await window.skillsAPI?.importBundle(dirPath);
      if (!result?.success) throw new Error(result?.error ?? "Import failed");
      return result;
    },
    onSuccess: (result) => {
      const name = result.skill?.name ?? "unknown";
      const dirs = result.bundleDirs;
      const msg =
        dirs && dirs.length > 0
          ? `Imported skill bundle "${name}" (${dirs.length} ${dirs.length === 1 ? "directory" : "directories"})`
          : `Imported skill bundle "${name}"`;
      setStatus({ type: "success", message: withSafetyWarning(msg, result.warnings) });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => {
      // User-initiated dismissals (picker cancel, conflict skip/cancel) — not real errors
      const msg = err instanceof Error ? err.message : String(err);
      if (!(SKILL_IMPORT_DISMISSED as readonly string[]).includes(msg)) {
        setStatus({ type: "error", message: String(err) });
      }
    },
  });

  const addSkillMutation = useMutation({
    mutationFn: async (args: {
      name: string;
      description: string;
      instructions: string;
      displayName?: string;
    }) => {
      const result = await window.skillsAPI?.add(
        args.name,
        args.description,
        args.instructions,
        args.displayName || undefined,
      );
      if (!result?.success) throw new Error(result?.error ?? "Failed to create skill");
      return { ...result, displayName: args.displayName, inputName: args.name };
    },
    onSuccess: (result) => {
      setStatus({
        type: "success",
        message: withSafetyWarning(
          `Created skill "${result.displayName || result.skill?.name || result.inputName}"`,
          result.warnings,
        ),
      });
      setShowAddSkill(false);
    },
    onError: (err) => setStatus({ type: "error", message: String(err) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });

  const editSkillMutation = useMutation({
    mutationFn: async (args: {
      name: string;
      description: string;
      instructions: string;
      displayName?: string;
    }) => {
      const skill = installedSkills.find((s: { name: string }) => s.name === args.name);
      if (!skill) throw new Error("Skill not found");
      const result = await window.skillsAPI?.update((skill as { id: string }).id, {
        displayName: args.displayName || undefined,
        description: args.description,
        instructions: args.instructions,
      });
      if (!result?.success) throw new Error(result?.error ?? "Failed to update skill");
      return { displayName: args.displayName, name: args.name, warnings: result.warnings };
    },
    onSuccess: (result) => {
      setStatus({
        type: "success",
        message: withSafetyWarning(
          `Updated skill "${result.displayName || result.name}"`,
          result.warnings,
        ),
      });
      setEditingSkill(null);
    },
    onError: (err) => setStatus({ type: "error", message: String(err) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });

  const toggleSkillMutation = useMutation({
    mutationFn: async (args: { id: string; enabled: boolean }) => {
      const result = await window.skillsAPI?.update(args.id, { enabled: args.enabled });
      if (!result?.success) throw new Error(result?.error ?? "Failed to toggle skill");
      return args.enabled;
    },
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: ["skills"] });
      const previous = queryClient.getQueryData<Array<{ id: string; enabled: boolean }>>([
        "skills",
      ]);
      queryClient.setQueryData<Array<{ id: string; enabled: boolean }>>(["skills"], (prev) =>
        prev?.map((s) => (s.id === args.id ? { ...s, enabled: args.enabled } : s)),
      );
      return { previous };
    },
    onError: (err, _args, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["skills"], ctx.previous);
      setStatus({ type: "error", message: String(err) });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });

  const removeSkillMutation = useMutation({
    mutationFn: async (name: string) => {
      const skill = installedSkills.find((s: { name: string }) => s.name === name);
      if (!skill) throw new Error("Skill not found");
      const result = await window.skillsAPI?.delete(skill.id);
      if (!result?.success) throw new Error(result?.error ?? "Delete failed");
      return name;
    },
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: ["skills"] });
      const previous = queryClient.getQueryData<Skill[]>(["skills"]);
      queryClient.setQueryData<Skill[]>(
        ["skills"],
        (prev) => prev?.filter((s) => s.name !== name) ?? [],
      );
      return { previous };
    },
    onSuccess: (name) => setStatus({ type: "success", message: `Removed skill "${name}"` }),
    onError: (err, _name, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["skills"], ctx.previous);
      setStatus({ type: "error", message: String(err) });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });

  // ── MCP mutations ───────────────────────────────────────────────────────

  const addMcpMutation = useMutation({
    mutationFn: async (input: AddMcpServerInput) => {
      const result = await window.mcpsAPI?.add(input);
      if (!result?.success) throw new Error(result?.error ?? "Failed to add server");
      return result;
    },
    onSuccess: (result) => {
      setStatus({
        type: "success",
        message: result.needsOAuth
          ? `Added MCP server "${result.name}". Use Sign in on the card to authenticate.`
          : `Added MCP server "${result.name}"`,
      });
      setNewMcpName("");
      setNewMcpUrl("");
      setNewMcpCommand("");
      setNewMcpBearerToken("");
      setNewMcpTimeoutSeconds("");
      setNewMcpTransport("http");
      setNewMcpEnvFile("");
      setAddingMcp(false);
    },
    onError: (err) => setStatus({ type: "error", message: String(err) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });

  const removeMcpMutation = useMutation({
    mutationFn: async (name: string) => {
      const result = await window.mcpsAPI?.remove(name);
      if (!result?.success) throw new Error(result?.error ?? "Remove failed");
      return name;
    },
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: ["mcp-servers"] });
      const previous = queryClient.getQueryData<McpServerInfo[]>(["mcp-servers"]);
      queryClient.setQueryData<McpServerInfo[]>(
        ["mcp-servers"],
        (prev) => prev?.filter((s) => s.name !== name) ?? [],
      );
      return { previous };
    },
    onSuccess: (name) => setStatus({ type: "success", message: `Removed MCP server "${name}"` }),
    onError: (err, _name, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(["mcp-servers"], ctx.previous);
      setStatus({ type: "error", message: String(err) });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });

  const saveMcpConfigMutation = useMutation({
    mutationFn: async (args: { item: CatalogItem; values: Record<string, string> }) => {
      if (args.item.type !== "mcp-servers" || args.item.source.type !== "first-party") {
        throw new Error("Only first-party MCP servers support config");
      }
      const result = await window.mcpsAPI?.updateConfig({
        serverName: args.item.name,
        catalogContent: args.item.source.content,
        configParams: (args.item.configParams ?? []).map((p) => ({
          key: p.key,
          required: p.required,
        })),
        values: args.values,
      });
      if (!result?.success) throw new Error(result?.error ?? "Failed to save config");
      return args.item.displayName;
    },
    onSuccess: (displayName) =>
      setStatus({ type: "success", message: `Configured "${displayName}"` }),
    onError: (err) => setStatus({ type: "error", message: String(err) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });

  const installCatalogMutation = useMutation({
    mutationFn: async (item: CatalogItem) => {
      let warnings: SanitizationWarning[] | undefined;
      if (item.source.type === "bundled") return { item: undefined, warnings };
      if (item.type === "skills" && item.source.type === "first-party") {
        const result = await window.skillsAPI?.add(
          item.name,
          item.description,
          item.source.content,
        );
        if (!result?.success) throw new Error(result?.error ?? "Install failed");
        warnings = result.warnings;
      } else if (item.type === "skills" && item.source.type === "url") {
        const result = await window.skillsAPI?.importUrl(item.source.url);
        if (!result?.success) throw new Error(result?.error ?? "Install failed");
        warnings = result.warnings;
      } else if (item.type === "skills" && item.source.type === "github") {
        const rawUrl = `https://raw.githubusercontent.com/${item.source.repo}/main/${item.source.path}`;
        const result = await window.skillsAPI?.importUrl(rawUrl);
        if (!result?.success) throw new Error(result?.error ?? "Install failed");
        warnings = result.warnings;
      } else if (item.type === "mcp-servers" && item.source.type === "first-party") {
        const result = await window.mcpsAPI?.installCatalog({
          name: item.name,
          catalogContent: item.source.content,
        });
        if (!result?.success) throw new Error(result?.error ?? "Install failed");
      }
      return { item, warnings };
    },
    onMutate: (item) => {
      setInstallingIds((prev) => new Set(prev).add(item.id));
    },
    onSuccess: (result) => {
      if (result?.item) {
        setStatus({
          type: "success",
          message: withSafetyWarning(`Installed "${result.item.displayName}"`, result.warnings),
        });
      }
    },
    onError: (err) => setStatus({ type: "error", message: String(err) }),
    onSettled: (_data, _error, item) => {
      setInstallingIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });

  // ── Handler wrappers ────────────────────────────────────────────────────
  // Async wrappers use mutateAsync so callers (dialogs) can catch errors locally.
  // Fire-and-forget wrappers use mutate — errors go to onError callback above.

  const handleImportSkillUrl = async (url: string) => {
    setStatus(null);
    await importSkillUrlMutation.mutateAsync(url);
  };

  const handleImportSkillBundle = async (dirPath?: string) => {
    setStatus(null);
    await importSkillBundleMutation.mutateAsync(dirPath);
  };

  const importSkillContentsMutation = useMutation({
    mutationFn: async (files: Array<{ content: string; name: string }>) => {
      const result = await window.skillsAPI?.importContents(
        files.map((f) => ({ content: f.content, fileName: f.name })),
      );
      if (!result || (!result.success && !result.errors?.length)) {
        throw new Error("Failed to import skills");
      }
      return result;
    },
    onSuccess: (result) => {
      const names = result.succeeded.map((s) => withSafetyWarning(s.name, s.warnings));
      if (names.length > 0) {
        const msg =
          names.length === 1 ? `Imported skill "${names[0]}"` : `Imported ${names.length} skills`;
        setStatus({
          type: "success",
          message: result.errors.length > 0 ? `${msg} (${result.errors.length} failed)` : msg,
        });
      } else if (result.errors.length > 0) {
        setStatus({ type: "error", message: "Failed to import skills" });
      }
    },
    onError: (err) => setStatus({ type: "error", message: String(err) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["skills"] }),
  });

  const handleImportSkillContents = async (
    files: Array<{ content: string; name: string }>,
  ): Promise<{ succeeded: string[]; errors: Array<{ fileName: string; error: string }> }> => {
    setStatus(null);
    try {
      const result = await importSkillContentsMutation.mutateAsync(files);
      const succeeded = result.succeeded.map((s) => s.name);
      return { succeeded, errors: result.errors };
    } catch {
      return { succeeded: [], errors: [{ fileName: "(all)", error: "Import failed" }] };
    }
  };

  const handleAddSkill = (
    name: string,
    description: string,
    instructions: string,
    displayName?: string,
  ) => {
    setStatus(null);
    addSkillMutation.mutate({ name, description, instructions, displayName });
  };

  const handleEditSkill = (
    name: string,
    description: string,
    instructions: string,
    displayName?: string,
  ) => {
    setStatus(null);
    editSkillMutation.mutate({ name, description, instructions, displayName });
  };

  const handleToggleSkill = (id: string, enabled: boolean) => {
    toggleSkillMutation.mutate({ id, enabled });
  };

  const handleRemoveCustomSkill = (name: string) => {
    setStatus(null);
    removeSkillMutation.mutate(name);
  };

  const handleAddMcp = async () => {
    if (!newMcpName.trim()) return;
    setStatus(null);

    // Convert seconds → milliseconds for the IPC call. Empty string = SDK default.
    // Throwing (rather than calling setStatus) lets AddMcpDialog.handleSave catch
    // the error and display it inside the dialog modal — the status banner is
    // rendered behind the dialog and would be hidden from the user.
    const trimmedTimeout = newMcpTimeoutSeconds.trim();
    let timeoutMs: number | undefined;
    if (trimmedTimeout) {
      const seconds = Number(trimmedTimeout);
      // Bound the seconds value so seconds * 1000 stays a safe integer; this
      // matches the IPC handler's safe-integer check on the resulting ms value
      // and avoids surfacing a misleading "must be an integer" error from the
      // backend for an integer that just exceeds the safe-int range once scaled.
      const MAX_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
      if (
        !Number.isFinite(seconds) ||
        !Number.isInteger(seconds) ||
        seconds <= 0 ||
        seconds > MAX_SECONDS
      ) {
        throw new Error("Timeout must be a positive whole number of seconds");
      }
      timeoutMs = seconds * 1000;
    }

    const envFile = newMcpMode === "command" ? newMcpEnvFile.trim() || undefined : undefined;

    await addMcpMutation.mutateAsync({
      name: newMcpName.trim(),
      mode: newMcpMode,
      url: newMcpUrl.trim() || undefined,
      command: newMcpCommand.trim() || undefined,
      bearerToken: newMcpBearerToken.trim() || undefined,
      timeout: timeoutMs,
      ...(newMcpMode === "url" ? { transport: newMcpTransport } : {}),
      ...(envFile ? { envFile } : {}),
    });
  };

  const handleRemoveMcp = (name: string) => {
    setStatus(null);
    removeMcpMutation.mutate(name);
  };

  const handleInstallCatalogItem = (item: CatalogItem) => {
    setStatus(null);
    installCatalogMutation.mutate(item);
  };

  const handleSaveConfig = (item: CatalogItem, values: Record<string, string>) => {
    setStatus(null);
    saveMcpConfigMutation.mutate({ item, values });
  };

  const getConfigValues = useCallback(
    (item: CatalogItem): Record<string, string> | undefined => {
      if (!item.configParams) return undefined;
      const server = allMcpServers.find((s: { name: string }) => s.name === item.name);
      if (!server) return undefined;
      const serverArgs: string[] =
        "args" in server && Array.isArray(server.args) ? server.args.map(String) : [];
      const baseDef = parseCatalogContent(item.source);
      const baseArgCount = baseDef?.args?.length ?? 0;
      const configArgs = serverArgs.slice(baseArgCount);
      const values: Record<string, string> = {};
      item.configParams.forEach((param, i) => {
        const arg = configArgs[i];
        values[param.key] = arg && !arg.startsWith("--") ? arg : "";
      });
      return values;
    },
    [allMcpServers],
  );

  const handleOpenFile = (item: CatalogItem) => {
    if (item.type === "skills") void window.skillsAPI?.openFile(item.name);
    else if (item.type === "mcp-servers") void window.mcpsAPI?.openFile();
  };

  return {
    // Status (derived from mutations)
    importError: status?.type === "error" ? status.message : null,
    importSuccess: status?.type === "success" ? status.message : null,
    // Skill dialog state
    showImport,
    setShowImport,
    showAddSkill,
    setShowAddSkill,
    editingSkill,
    setEditingSkill,
    // MCP form props (grouped for McpServersTab passthrough)
    mcpFormProps: {
      addingMcp,
      onAddMcpOpen: () => setAddingMcp(true),
      newMcpName,
      newMcpUrl,
      newMcpCommand,
      newMcpBearerToken,
      newMcpTimeoutSeconds,
      newMcpEnvFile,
      newMcpMode,
      newMcpTransport,
      onNameChange: setNewMcpName,
      onUrlChange: setNewMcpUrl,
      onCommandChange: setNewMcpCommand,
      onBearerTokenChange: setNewMcpBearerToken,
      onTimeoutSecondsChange: setNewMcpTimeoutSeconds,
      onEnvFileChange: setNewMcpEnvFile,
      onModeChange: setNewMcpMode,
      onTransportChange: setNewMcpTransport,
      onAddMcpSave: handleAddMcp,
      onAddMcpClose: () => {
        setNewMcpEnvFile("");
        setAddingMcp(false);
      },
    },
    // Handlers
    clearStatus,
    handleImportSkillUrl,
    handleImportSkillBundle,
    handleImportSkillContents,
    handleAddSkill,
    handleEditSkill,
    handleToggleSkill,
    handleRemoveCustomSkill,
    handleRemoveMcp,
    handleInstallCatalogItem,
    runtimeMutationPending: runtimeMutation.isPending || runtimeLocalInstallMutation.isPending,
    handleRuntimeInstallDetected: (packageRoot: string) => {
      setStatus(null);
      runtimeLocalInstallMutation.mutate(packageRoot);
    },
    handleRuntimeInstallLocal: async () => {
      const result = await window.workspaceAPI?.pickFolder();
      if (!result?.success) {
        if (result?.error !== "Folder selection cancelled") {
          setStatus({ type: "error", message: result?.error ?? "Folder selection failed." });
        }
        return;
      }
      if (!result.folderPath) {
        setStatus({ type: "error", message: "The selected folder path was unavailable." });
        return;
      }
      runtimeLocalInstallMutation.mutate(result.folderPath);
    },
    handleRuntimeInstall: (entry: RuntimeExtensionCatalogEntry) =>
      runRuntimeMutation("install", entry),
    handleRuntimeUpdate: (entry: RuntimeExtensionCatalogEntry) =>
      runRuntimeMutation("update", entry),
    handleRuntimeUpdateFromDirectory: async (entry: RuntimeExtensionCatalogEntry) => {
      const result = await window.workspaceAPI?.pickFolder();
      if (!result?.success) {
        if (result?.error !== "Folder selection cancelled") {
          setStatus({ type: "error", message: result?.error ?? "Folder selection failed." });
        }
        return;
      }
      if (!result.folderPath) {
        setStatus({ type: "error", message: "The selected folder path was unavailable." });
        return;
      }
      runRuntimeMutation(
        "updateFromDirectory",
        entry,
        undefined,
        undefined,
        undefined,
        result.folderPath,
      );
    },
    handleRuntimeEnable: (entry: RuntimeExtensionCatalogEntry) =>
      runRuntimeMutation("enable", entry),
    handleRuntimeDisable: (entry: RuntimeExtensionCatalogEntry) =>
      runRuntimeMutation("disable", entry),
    handleRuntimeRemove: (entry: RuntimeExtensionCatalogEntry) =>
      runRuntimeMutation("remove", entry),
    handleRuntimeConfigure: (
      entry: RuntimeExtensionCatalogEntry,
      configuration: Readonly<Record<string, unknown>>,
    ) => runRuntimeMutation("configure", entry, undefined, configuration),
    handleRuntimeChooseProvider: (
      entry: RuntimeExtensionCatalogEntry,
      provider: string,
      serviceId: string,
    ) => runRuntimeMutation("setProvider", entry, provider, undefined, serviceId),
    handleRuntimeClearProvider: (entry: RuntimeExtensionCatalogEntry, serviceId: string) =>
      runRuntimeMutation("clearProvider", entry, undefined, undefined, serviceId),
    handleRuntimeRepairContractConflict: (
      entry: RuntimeExtensionCatalogEntry,
      conflict: RuntimeExtensionContractConflict,
    ) =>
      runRuntimeMutation(
        "repairContractConflict",
        entry,
        undefined,
        undefined,
        undefined,
        undefined,
        conflict,
      ),
    getConfigValues,
    handleSaveConfig,
    handleOpenFile,
  };
}
