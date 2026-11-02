import type {
  MainSessionContextSelection,
  SessionRepositoryAgent,
  WorkspaceInstanceIdentity,
} from "@common/marshal-ipc-contract";
import { isVoiceTranscriptionAvailable } from "@common/runtime-config";
import { RUNTIME_UI_PLACEMENT } from "@common/runtime-ui";

import { Paperclip, Plus, SlidersHorizontal } from "@/components/icons";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@/components/marshal-ui/marshal-popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RuntimeUiPlacementActionButton, useRuntimeUiPlacement } from "@/features/runtime-ui";
import { useSettings } from "@/features/settings/useSettings";
import { InteractiveElementMonitor_AttachFile } from "@/services/telemetry/schema";

import { MicButton } from "./MicButton";
import { ModelPicker, ModelSelectionLabel } from "./ModelPicker";
import { ReasoningEffortPicker } from "./ReasoningEffortPicker";
import { WorkspaceRolePicker } from "./WorkspaceRolePicker";

interface ChatInputAddOnsProps {
  sessionId?: string | null;
  sdkReady: boolean;
  hasUserMessages: boolean;
  workspaceName?: string;
  workspaceIdentity?: WorkspaceInstanceIdentity;
  workspaceBindingInvalid?: boolean;
  repositoryAgent?: SessionRepositoryAgent;
  workspaceRoleDisabled?: boolean;
  onWorkspaceRoleChange?: (selection: MainSessionContextSelection) => Promise<void>;
  /** Gates the soul control surfaced inside the workspace picker. */
  soulContextReady?: boolean;
  onSoulChange?: (soulId: string) => void;
  hideAttachments?: boolean;
  onPickFile: () => void;
  /** Receives transcribed text from the microphone control. */
  onTranscript: (text: string) => void;
}

/**
 * Left-side compose-bar controls: the workspace/role/soul picker, the
 * model picker dropdown, the reasoning-effort knob, the add-content placement,
 * and voice when available.
 */
export function ChatInputAddOns({
  sessionId,
  sdkReady,
  hasUserMessages,
  workspaceName,
  workspaceIdentity,
  workspaceBindingInvalid,
  repositoryAgent,
  workspaceRoleDisabled,
  onWorkspaceRoleChange,
  soulContextReady,
  onSoulChange,
  hideAttachments,
  onPickFile,
  onTranscript,
}: ChatInputAddOnsProps) {
  const { settings } = useSettings();
  const voiceEnabled = !window.marshalRemote && isVoiceTranscriptionAvailable(settings.runtimeId);
  const addContentPlacement = useRuntimeUiPlacement(RUNTIME_UI_PLACEMENT.CHAT_COMPOSER_ADD);
  const placementApplications = addContentPlacement.applications;
  const replacementApplication = placementApplications.find(
    (application) => application.action === "replace",
  );
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {onWorkspaceRoleChange && (
        <WorkspaceRolePicker
          key={JSON.stringify([
            sessionId,
            workspaceName,
            workspaceIdentity,
            workspaceBindingInvalid,
            repositoryAgent?.identity,
          ])}
          sessionId={sessionId}
          workspaceName={workspaceName}
          workspaceIdentity={workspaceIdentity}
          workspaceBindingInvalid={workspaceBindingInvalid}
          repositoryAgent={repositoryAgent}
          hasUserMessages={hasUserMessages}
          disabled={workspaceRoleDisabled}
          soulContextReady={soulContextReady}
          onApply={onWorkspaceRoleChange}
          onSoulChange={onSoulChange}
        />
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-10 max-w-full min-w-10 gap-1.5 rounded-full px-2.5"
            disabled={!sdkReady}
            aria-label="Models"
            data-testid="options-popover"
          >
            <SlidersHorizontal size={20} className="shrink-0" />
            <ModelSelectionLabel sessionId={sessionId} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64" align="start" side="top">
          <ModelPicker sessionId={sessionId} />
        </DropdownMenuContent>
      </DropdownMenu>

      <ReasoningEffortPicker sessionId={sessionId} disabled={!sdkReady} />

      <InteractiveElementMonitor_AttachFile callback={() => {}} interactionDisabled={!sdkReady}>
        {hideAttachments
          ? null
          : (cb, isDisabled) =>
              replacementApplication ? (
                <RuntimeUiPlacementActionButton
                  application={replacementApplication}
                  sessionId={sessionId ?? ""}
                  workspaceName={workspaceName ?? "marshal"}
                  presentation="icon"
                  disabled={isDisabled}
                />
              ) : placementApplications.length === 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-10 rounded-full"
                  disabled={isDisabled}
                  aria-label="Upload file"
                  data-testid="attachment-popover"
                  onClick={() => {
                    cb();
                    onPickFile();
                  }}
                >
                  <Plus size={20} />
                </Button>
              ) : (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-10 rounded-full"
                      disabled={isDisabled}
                      aria-label="Add content"
                      data-testid="attachment-popover"
                      onClick={cb}
                    >
                      <Plus size={20} />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-48 p-1" align="start" side="top">
                    <PopoverClose asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full justify-start gap-2 font-normal"
                        onClick={onPickFile}
                      >
                        <Paperclip size={16} /> Upload file
                      </Button>
                    </PopoverClose>
                    {placementApplications.map((application) => (
                      <PopoverClose
                        key={`${application.extensionId}:${application.applicationId}`}
                        asChild
                      >
                        <RuntimeUiPlacementActionButton
                          application={application}
                          sessionId={sessionId ?? ""}
                          workspaceName={workspaceName ?? "marshal"}
                          presentation="menu"
                        />
                      </PopoverClose>
                    ))}
                  </PopoverContent>
                </Popover>
              )}
      </InteractiveElementMonitor_AttachFile>

      {voiceEnabled ? <MicButton disabled={!sdkReady} onTranscript={onTranscript} /> : null}
    </div>
  );
}
