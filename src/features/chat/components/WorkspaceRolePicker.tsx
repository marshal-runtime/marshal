import type {
  MainSessionContextSelection,
  MainSessionWorkspaceBinding,
  SessionRepositoryAgent,
  WorkspaceInstanceIdentity,
} from "@common/marshal-ipc-contract";
import { workspaceDisplayName } from "@common/workspace-display";
import {
  repositoryAgentBindingKey,
  repositoryAgentsEqual,
  workspaceBindingKey,
  workspaceBindingsEqual,
} from "@common/workspace-role-identity";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { MarshalBotIcon } from "@/assets/icons/nav-icons";
import { AlertTriangle, ChevronDown, FolderCog, FolderPlus } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/marshal-ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/marshal-ui/marshal-tooltip";

import { useSoulSelection } from "../hooks/useSoulSelection";

const DEFAULT_WORKSPACE_VALUE = "__marshal_default_workspace__";
const DEFAULT_ROLE_VALUE = "__marshal_default_role__";
const CHECKING_WORKSPACE_VALUE = "__marshal_checking_workspace__";
const CHECKING_ROLE_VALUE = "__marshal_checking_role__";
const MISSING_WORKSPACE_VALUE = "__marshal_missing_workspace__";
const MISSING_ROLE_VALUE = "__marshal_missing_role__";

interface WorkspaceRolePickerProps {
  sessionId?: string | null;
  workspaceName?: string;
  workspaceIdentity?: WorkspaceInstanceIdentity;
  workspaceBindingInvalid?: boolean;
  repositoryAgent?: SessionRepositoryAgent;
  hasUserMessages: boolean;
  disabled?: boolean;
  /** Gates the soul control the same way the old picker did. */
  soulContextReady?: boolean;
  onApply: (selection: MainSessionContextSelection) => Promise<void>;
  /** Present ⇒ surface the Marshal agent soul inside this picker. */
  onSoulChange?: (soulId: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (/no longer matches|unavailable|changed/i.test(message)) {
    return "The selected workspace or role changed before the new chat started. Choose it again.";
  }
  return message;
}

async function listRepositoryAgents(workspaceName: string): Promise<SessionRepositoryAgent[]> {
  if (!window.workspaceAPI) throw new Error("Workspace API is not available");
  const result = await window.workspaceAPI.listRepositoryAgents(workspaceName);
  if (!result.success) {
    throw new Error(result.error || `Could not list roles for ${workspaceName}`);
  }
  return result.agents ?? [];
}

export function WorkspaceRolePicker({
  sessionId,
  workspaceName,
  workspaceIdentity,
  workspaceBindingInvalid,
  repositoryAgent,
  hasUserMessages,
  disabled,
  soulContextReady = true,
  onApply,
  onSoulChange,
}: WorkspaceRolePickerProps) {
  const {
    souls,
    currentId: currentSoulId,
    select: selectSoul,
  } = useSoulSelection(sessionId, onSoulChange);
  const soulDisabled = !soulContextReady || hasUserMessages;

  const currentWorkspaceBinding =
    workspaceName && workspaceIdentity
      ? { name: workspaceName, identity: workspaceIdentity }
      : undefined;
  const [open, setOpen] = useState(false);
  const [pendingWorkspaceOverride, setPendingWorkspaceOverride] = useState<
    MainSessionWorkspaceBinding | null | undefined
  >(undefined);
  const [pendingRoleOverride, setPendingRoleOverride] = useState<
    SessionRepositoryAgent | null | undefined
  >(undefined);
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);

  const workspacesQuery = useQuery({
    queryKey: ["workspaces", "main-session-context"],
    queryFn: async () => {
      if (!window.workspaceAPI) throw new Error("Workspace API is not available");
      const result = await window.workspaceAPI.listWorkspaces();
      if (!result.success) throw new Error(result.error || "Could not list workspaces");
      return result.workspaceBindings ?? [];
    },
    staleTime: 0,
  });

  const workspaces = workspacesQuery.data ?? [];
  const validatedCurrentWorkspace =
    !workspaceBindingInvalid && currentWorkspaceBinding && workspacesQuery.isSuccess
      ? workspaces.find((workspace) => workspaceBindingsEqual(workspace, currentWorkspaceBinding))
      : undefined;
  const currentWorkspaceUnavailable =
    !!workspaceName &&
    (workspaceBindingInvalid ||
      !currentWorkspaceBinding ||
      (workspacesQuery.isSuccess && !validatedCurrentWorkspace));

  const currentAgentsQuery = useQuery({
    queryKey: [
      "workspace",
      "repository-agents",
      validatedCurrentWorkspace ? workspaceBindingKey(validatedCurrentWorkspace) : "none",
    ],
    queryFn: () =>
      validatedCurrentWorkspace ? listRepositoryAgents(validatedCurrentWorkspace.name) : [],
    enabled: !!validatedCurrentWorkspace && !!repositoryAgent,
    staleTime: 0,
  });

  const validatedCurrentRole =
    repositoryAgent?.identity && currentAgentsQuery.isSuccess
      ? currentAgentsQuery.data.find((agent) => repositoryAgentsEqual(agent, repositoryAgent))
      : undefined;
  const currentRoleUnavailable =
    !!repositoryAgent &&
    (currentWorkspaceUnavailable ||
      !repositoryAgent.identity ||
      (!!validatedCurrentWorkspace && currentAgentsQuery.isSuccess && !validatedCurrentRole));
  const contextUnavailable = currentWorkspaceUnavailable || currentRoleUnavailable;

  const pendingWorkspace =
    pendingWorkspaceOverride === undefined
      ? validatedCurrentWorkspace
      : (pendingWorkspaceOverride ?? undefined);
  const pendingWorkspaceKey = pendingWorkspace ? workspaceBindingKey(pendingWorkspace) : undefined;
  const pendingWorkspaceName = pendingWorkspace?.name;
  const pendingUsesCurrentWorkspace = workspaceBindingsEqual(
    pendingWorkspace,
    validatedCurrentWorkspace,
  );
  const pendingRole =
    pendingRoleOverride === undefined
      ? pendingUsesCurrentWorkspace
        ? validatedCurrentRole
        : undefined
      : (pendingRoleOverride ?? undefined);
  const pendingRoleKey = pendingRole ? repositoryAgentBindingKey(pendingRole) : undefined;

  const agentsQuery = useQuery({
    queryKey: [
      "workspace",
      "repository-agents",
      pendingWorkspaceKey ?? DEFAULT_WORKSPACE_VALUE,
      pendingWorkspaceName,
    ],
    queryFn: () => (pendingWorkspaceName ? listRepositoryAgents(pendingWorkspaceName) : []),
    enabled: !!pendingWorkspaceName,
    staleTime: 0,
  });
  const agents = agentsQuery.data ?? [];

  const applyMutation = useMutation({
    mutationFn: (selection: MainSessionContextSelection) => onApply(selection),
    onSuccess: () => setOpen(false),
  });

  const addWorkspaceMutation = useMutation({
    mutationFn: async () => {
      if (!window.workspaceAPI) throw new Error("Workspace API is not available");
      const picked = await window.workspaceAPI.pickFolder();
      if (!picked.success) {
        if (picked.error === "Folder selection cancelled") return undefined;
        throw new Error(picked.error || "Could not select a workspace folder");
      }
      if (!picked.folderPath || !picked.folderToken) {
        throw new Error("Folder selection did not return a workspace path token");
      }
      const name = picked.folderPath.split(/[\\/]/).pop()?.trim();
      if (!name) throw new Error("The selected folder does not have a valid workspace name");
      const created = await window.workspaceAPI.createWorkspace(name, picked.folderToken);
      if (!created.success) throw new Error(created.error || "Could not add workspace");
      const refreshed = await workspacesQuery.refetch();
      const workspace = refreshed.data?.find((candidate) => candidate.name === name);
      if (!workspace) throw new Error("The added workspace is not available");
      return workspace;
    },
    onSuccess: (workspace) => {
      if (!workspace) return;
      setPendingWorkspaceOverride(workspace);
      setPendingRoleOverride(null);
    },
  });

  const pendingWorkspaceMissing =
    !!pendingWorkspaceOverride &&
    workspacesQuery.isSuccess &&
    !workspaces.some((workspace) => workspaceBindingsEqual(workspace, pendingWorkspaceOverride));
  const pendingRoleMissing =
    !!pendingRoleOverride &&
    agentsQuery.isSuccess &&
    !agents.some((agent) => repositoryAgentsEqual(agent, pendingRoleOverride));
  const checkingWorkspace =
    pendingWorkspaceOverride === undefined &&
    !!currentWorkspaceBinding &&
    !workspaceBindingInvalid &&
    workspacesQuery.isPending;
  const checkingRole =
    pendingRoleOverride === undefined &&
    !!repositoryAgent &&
    !!validatedCurrentWorkspace &&
    currentAgentsQuery.isPending;
  const pendingWorkspaceAvailable =
    !pendingWorkspace ||
    (workspacesQuery.isSuccess &&
      workspaces.some((workspace) => workspaceBindingsEqual(workspace, pendingWorkspace)));
  const pendingRoleAvailable =
    !pendingRole ||
    (agentsQuery.isSuccess && agents.some((agent) => repositoryAgentsEqual(agent, pendingRole)));
  const canApply =
    !checkingWorkspace &&
    !checkingRole &&
    !pendingWorkspaceMissing &&
    !pendingRoleMissing &&
    pendingWorkspaceAvailable &&
    pendingRoleAvailable &&
    !applyMutation.isPending &&
    !addWorkspaceMutation.isPending;

  const activeWorkspaceLabel = workspaceName ? workspaceDisplayName(workspaceName) : "No workspace";
  const activeRoleLabel = repositoryAgent?.name ?? "Default";
  const triggerSummary = contextUnavailable
    ? "Context unavailable"
    : `${activeWorkspaceLabel} · ${activeRoleLabel}`;
  const triggerDetails = contextUnavailable
    ? `Previous context unavailable. Workspace: ${activeWorkspaceLabel}. Role: ${activeRoleLabel}.`
    : `Chat context: ${triggerSummary}`;

  const workspaceSelectValue = checkingWorkspace
    ? CHECKING_WORKSPACE_VALUE
    : pendingWorkspaceMissing
      ? MISSING_WORKSPACE_VALUE
      : (pendingWorkspaceKey ?? DEFAULT_WORKSPACE_VALUE);
  const roleSelectValue = checkingRole
    ? CHECKING_ROLE_VALUE
    : pendingRoleMissing
      ? MISSING_ROLE_VALUE
      : (pendingRoleKey ?? DEFAULT_ROLE_VALUE);

  const selectionError = addWorkspaceMutation.isError
    ? errorMessage(addWorkspaceMutation.error)
    : applyMutation.isError
      ? applyErrorMessage(applyMutation.error)
      : pendingWorkspaceMissing
        ? "That workspace is no longer available. Choose another workspace."
        : pendingRoleMissing
          ? "That role is no longer available. Choose Default or another role."
          : workspacesQuery.isError
            ? "Workspace choices could not be loaded. You can still start without a workspace."
            : pendingWorkspace && agentsQuery.isError
              ? `Roles for ${pendingWorkspace.name} could not be loaded. Default is still available.`
              : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setPendingWorkspaceOverride(undefined);
          setPendingRoleOverride(undefined);
          applyMutation.reset();
          addWorkspaceMutation.reset();
          void workspacesQuery.refetch();
          if (validatedCurrentWorkspace && repositoryAgent) {
            void currentAgentsQuery.refetch();
          }
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-10 max-w-44 min-w-0 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:text-foreground"
              style={{ maxWidth: "min(11rem, 35vw)" }}
              disabled={disabled}
              aria-label={`${triggerDetails} Choose context for a new chat.`}
              aria-invalid={contextUnavailable || undefined}
              title={triggerDetails}
              data-testid="workspace-role-trigger"
            >
              {contextUnavailable ? (
                <AlertTriangle className="size-4 shrink-0 text-destructive" />
              ) : (
                <FolderCog className="size-4 shrink-0" />
              )}
              <span className="truncate">{triggerSummary}</span>
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {triggerDetails}
        </TooltipContent>
      </Tooltip>

      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="workspace-role-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          workspaceTriggerRef.current?.focus();
        }}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>Start a new chat</DialogTitle>
          <DialogDescription>
            Choose its workspace and role.{" "}
            {hasUserMessages
              ? "This conversation and its draft stay available."
              : "This chat and any draft stay available."}
          </DialogDescription>
        </DialogHeader>

        {contextUnavailable && (
          <div
            className="flex gap-2.5 rounded-lg border border-destructive/25 bg-destructive/5 p-3"
            data-testid="previous-context-status"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-1.5">
              <p className="text-sm font-medium">Previous context is unavailable</p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
                {currentWorkspaceUnavailable && workspaceName && (
                  <>
                    <dt className="text-muted-foreground">Workspace</dt>
                    <dd className="wrap-break-word" title={workspaceDisplayName(workspaceName)}>
                      {workspaceDisplayName(workspaceName)}
                    </dd>
                  </>
                )}
                {currentRoleUnavailable && repositoryAgent && (
                  <>
                    <dt className="text-muted-foreground">Role</dt>
                    <dd className="wrap-break-word" title={repositoryAgent.name}>
                      {repositoryAgent.name}
                    </dd>
                  </>
                )}
              </dl>
              <p className="text-xs text-muted-foreground">
                Choose a current option below. Nothing is selected again automatically.
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="main-session-workspace">Workspace</Label>
            <Select
              value={workspaceSelectValue}
              onValueChange={(value) => {
                setPendingWorkspaceOverride(
                  value === DEFAULT_WORKSPACE_VALUE
                    ? null
                    : (workspaces.find((workspace) => workspaceBindingKey(workspace) === value) ??
                        null),
                );
                setPendingRoleOverride(null);
                applyMutation.reset();
              }}
            >
              <SelectTrigger
                ref={workspaceTriggerRef}
                id="main-session-workspace"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start" collisionPadding={8}>
                {checkingWorkspace && (
                  <SelectItem value={CHECKING_WORKSPACE_VALUE} disabled>
                    Checking current workspace...
                  </SelectItem>
                )}
                {pendingWorkspaceMissing && pendingWorkspaceOverride && (
                  <SelectItem value={MISSING_WORKSPACE_VALUE} disabled>
                    {workspaceDisplayName(pendingWorkspaceOverride.name)} (no longer available)
                  </SelectItem>
                )}
                <SelectItem value={DEFAULT_WORKSPACE_VALUE}>No workspace</SelectItem>
                {workspaces.map((workspace) => (
                  <SelectItem
                    key={workspaceBindingKey(workspace)}
                    value={workspaceBindingKey(workspace)}
                  >
                    {workspaceDisplayName(workspace.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {workspaces.length <= 1
                  ? "Add a project folder to use it as workspace context."
                  : "Only explicitly added workspaces appear here."}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={addWorkspaceMutation.isPending}
                onClick={() => addWorkspaceMutation.mutate()}
              >
                <FolderPlus className="size-4" />
                {addWorkspaceMutation.isPending ? "Adding..." : "Add workspace"}
              </Button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="main-session-role">Role</Label>
            <Select
              value={roleSelectValue}
              disabled={!pendingWorkspace}
              onValueChange={(value) => {
                setPendingRoleOverride(
                  value === DEFAULT_ROLE_VALUE
                    ? null
                    : (agents.find((agent) => repositoryAgentBindingKey(agent) === value) ?? null),
                );
                applyMutation.reset();
              }}
            >
              <SelectTrigger id="main-session-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start" collisionPadding={8}>
                {checkingRole && (
                  <SelectItem value={CHECKING_ROLE_VALUE} disabled>
                    Checking current role...
                  </SelectItem>
                )}
                {pendingRoleMissing && pendingRoleOverride && (
                  <SelectItem value={MISSING_ROLE_VALUE} disabled>
                    {pendingRoleOverride.name} (no longer available)
                  </SelectItem>
                )}
                <SelectItem value={DEFAULT_ROLE_VALUE}>Default</SelectItem>
                {agents.flatMap((agent) => {
                  const agentKey = repositoryAgentBindingKey(agent);
                  return agentKey
                    ? [
                        <SelectItem key={agentKey} value={agentKey}>
                          {agent.name}
                        </SelectItem>,
                      ]
                    : [];
                })}
              </SelectContent>
            </Select>
            {pendingWorkspace && agentsQuery.isPending && (
              <p className="text-xs text-muted-foreground">Loading roles...</p>
            )}
            {pendingWorkspace && agentsQuery.isSuccess && agents.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No repository roles found. Default is available.
              </p>
            )}
          </div>

          {onSoulChange && (
            <div className="grid gap-1.5">
              <Label htmlFor="main-session-soul" data-testid="soul-picker">
                Soul
              </Label>
              <Select
                value={currentSoulId}
                disabled={soulDisabled}
                onValueChange={selectSoul}
              >
                <SelectTrigger
                  id="main-session-soul"
                  className="w-full"
                  data-testid="soul-trigger"
                >
                  <SelectValue placeholder="Default" />
                </SelectTrigger>
                <SelectContent position="popper" align="start" collisionPadding={8}>
                  {souls.map((soul) => (
                    <SelectItem key={soul.id} value={soul.id}>
                      <MarshalBotIcon className="size-4 shrink-0" />
                      <span>{soul.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {soulDisabled
                  ? "Soul is chosen before a chat's first message."
                  : "Sets how the Marshal agent responds."}
              </p>
            </div>
          )}
        </div>

        {selectionError && (
          <div role="alert" className="text-xs text-destructive">
            {selectionError}
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={applyMutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            size="sm"
            disabled={!canApply}
            onClick={() =>
              applyMutation.mutate({
                workspaceBinding: pendingWorkspace,
                repositoryAgent: pendingRole,
              })
            }
          >
            {pendingWorkspace ? "Select workspace" : "Start without workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
