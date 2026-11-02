import type {
  MainSessionContextSelection,
  SessionRepositoryAgent,
  WorkspaceInstanceIdentity,
} from "@common/marshal-ipc-contract";
import {
  type Ref,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { useInteractiveElementMonitor_Send } from "@/services/telemetry/schema";
import { useIsMobile } from "@/shared/hooks/useIsMobile";
import { useSkills } from "@/shared/hooks/useSkillCatalog";
import type { OverlayReviewSubmittedEvent } from "@/types/electron";

import { MAX_HISTORY, usePromptHistory } from "../composer/hooks/usePromptHistory";
import { useTypewriter } from "../composer/hooks/useTypewriter";
import { PickerController } from "../context-picker/PickerController";
import { InputEditor, type ChipDescriptor, type InputEditorHandle } from "../editor/InputEditor";
import { flattenChipsForSubmit, stripCtxMarkers } from "../editor/support/editor-support";
import { GoalWidget } from "../goal/GoalWidget";
import { getGoalSnapshotView } from "../goal/snapshotView";
import {
  fetchGoalSnapshot,
  requireGoalFence,
  setGoal,
  useGoalMutation,
} from "../goal/useGoalState";
import { useChatAttachments } from "../hooks/useChatAttachments";
import { useDraftSync } from "../hooks/useChatDraftSync";
import { useChatInputTestApi } from "../hooks/useChatInputTestingApi";
import type { QueuedMessage } from "../hooks/useMessageQueue";
import {
  stageDraftAttachments,
  peekDraftAttachments,
  clearDraftAttachmentTransfer,
} from "../state/sessionDraftAttachments";
import { clearAllDrafts, clearDraft, getDraft, migrateDraft } from "../state/sessionDrafts";
import { AttachmentPillList } from "./AttachmentPillList";
import { ChatInputActions, type ChatInputActionTarget } from "./ChatInputActions";
import { ChatInputAddOns } from "./ChatInputAddOns";
import { QueueWidget } from "./QueueWidget";

const EMPTY_QUEUE: QueuedMessage[] = [];

// eslint-disable-next-line react-refresh/only-export-components
export { _clearSessionDrafts } from "../state/sessionDrafts";

export interface FileAttachment {
  dataUrl?: string;
  path?: string;
  mimeType: string;
  name: string;
  largeFile?: boolean;
}

/** @deprecated Use FileAttachment */
export type ImageAttachment = FileAttachment;

export interface ChatInputRef {
  focus: () => void;
  setInput: (text: string) => void;
  /** Drip `text` into the editor (eased character-by-character). Cancels
   *  any in-flight drip first. Used by starter-prompt cards. */
  startTyping: (text: string) => void;
  clearHistory: () => void;
  hasInput: () => boolean;
  getInput: () => string;
  addContextFile: (filePath: string) => void;
  clearContextFiles: () => void;
  clearDraft: (sessionId?: string) => void;
  /** Seed the currently-typed input as a draft for a new session. By default
   *  the source draft moves; preserveSource keeps it on both chats. */
  migrateDraftToSession: (
    fromSessionId: string | null,
    toSessionId: string,
    draftText?: string,
    options?: { preserveSource?: boolean },
  ) => void;
}

/**
 * Child component that stabilizes the editor's keydown handler by combining
 * picker and ChatInput key handling with useCallback.
 */
function EditorWithStableKeydown({
  editorRef,
  initialValue,
  handleEditorChange,
  setChips,
  pickerHandleKeyDown,
  handleKeyDown,
  handleArrowAtBoundary,
  handleEditorEnter,
  onPickerKeyIntercept,
  pickerActive,
  pickerListboxId,
  pickerActiveDescendantId,
  sdkReady,
  initError,
  isWaiting,
  isCancelling,
  customPlaceholder,
  className,
}: {
  editorRef: React.RefObject<InputEditorHandle | null>;
  initialValue: string;
  handleEditorChange: (nextValue: string) => void;
  setChips: (chips: ChipDescriptor[]) => void;
  pickerHandleKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => boolean;
  handleKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  handleArrowAtBoundary: (direction: "up" | "down", value: string) => boolean;
  handleEditorEnter: (modifiers: { steer: boolean }) => boolean;
  onPickerKeyIntercept: (key: "Enter" | "Tab" | "Escape" | "ArrowUp" | "ArrowDown") => boolean;
  pickerActive: boolean;
  pickerListboxId: string | undefined;
  pickerActiveDescendantId: string | undefined;
  sdkReady: boolean;
  initError: string | null;
  isWaiting: boolean;
  isCancelling: boolean;
  customPlaceholder: string | undefined;
  className: string;
}) {
  const stableOnKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (pickerHandleKeyDown(e)) {
        return;
      }
      handleKeyDown(e);
    },
    [pickerHandleKeyDown, handleKeyDown],
  );

  return (
    <InputEditor
      ref={editorRef}
      initialValue={initialValue}
      onChange={handleEditorChange}
      onChipsChange={setChips}
      onKeyDown={stableOnKeyDown}
      onArrowAtBoundary={handleArrowAtBoundary}
      onEnter={handleEditorEnter}
      onPickerKeyIntercept={onPickerKeyIntercept}
      combobox={{
        hasPopup: "listbox",
        expanded: pickerActive,
        controls: pickerListboxId,
        activeDescendant: pickerActiveDescendantId,
      }}
      disabled={!sdkReady || !!initError}
      errorMessage={initError ?? undefined}
      placeholder={
        initError
          ? `Error: ${initError}`
          : !sdkReady
            ? "Initializing..."
            : isCancelling
              ? "Cancelling..."
              : isWaiting
                ? window.marshalRemote
                  ? "Steer this turn · hold Send to queue…"
                  : "Steer this turn, or hold Send to queue..."
                : (customPlaceholder ?? "Describe what you want to do")
      }
      ariaLabel="Message"
      testId="chat-input-editor"
      className={className}
    />
  );
}

interface ChatInputProps {
  ref?: Ref<ChatInputRef>;
  sessionId?: string | null;
  userMessages: ReadonlyArray<string>;
  isWaiting: boolean;
  isCancelling?: boolean;
  sdkReady: boolean;
  initError: string | null;
  hasUserMessages: boolean;
  header?: ReactNode;
  sessionContextReady?: boolean;
  soulContextReady?: boolean;
  hideAttachments?: boolean;
  placeholder?: string;
  onSubmit: (text: string, files: FileAttachment[], target: ChatInputActionTarget) => void;
  onStop: () => void;
  /** Steer: interrupt the running turn and send this content immediately. */
  onSteer?: (text: string, files: FileAttachment[], target: ChatInputActionTarget) => void;
  onSoulChange?: (soulId: string) => void;
  workspaceName?: string;
  workspaceIdentity?: WorkspaceInstanceIdentity;
  workspaceBindingInvalid?: boolean;
  repositoryAgent?: SessionRepositoryAgent;
  currentSoulId?: string;
  onWorkspaceRoleChange?: (
    selection: MainSessionContextSelection,
    context: { hasUserMessages: boolean; soulId?: string },
  ) => Promise<void>;
  currentTokens?: number;
  tokenLimit?: number;
  inputTokens?: number;
  /** Messages queued (held) for the active session while a turn runs. */
  queuedMessages?: QueuedMessage[];
  /** Steering message shown transiently while a turn is being interrupted. */
  steeringText?: string | null;
  onRemoveQueued?: (id: string) => void;
  onSteerQueued?: (id: string) => void;
}

export function ChatInput({
  ref,
  sessionId,
  userMessages,
  isWaiting,
  isCancelling = false,
  sdkReady,
  initError,
  hasUserMessages,
  header,
  sessionContextReady = true,
  soulContextReady = sessionContextReady,
  hideAttachments,
  placeholder: customPlaceholder,
  onSubmit,
  onStop,
  onSteer,
  onSoulChange,
  workspaceName,
  workspaceIdentity,
  workspaceBindingInvalid,
  repositoryAgent,
  currentSoulId,
  onWorkspaceRoleChange,
  currentTokens,
  tokenLimit,
  inputTokens,
  queuedMessages = EMPTY_QUEUE,
  steeringText,
  onRemoveQueued,
  onSteerQueued,
}: ChatInputProps) {
  const [input, setInput] = useState(() => getDraft(sessionId ?? "") ?? "");
  const [chips, setChips] = useState<ChipDescriptor[]>([]);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const isMobile = useIsMobile();
  const { mutateAsync: mutateGoal } = useGoalMutation(sessionId ?? "");
  // Counter handles dragenter/leave bubbling across child elements without flicker.
  const dragDepthRef = useRef(0);
  const editorRef = useRef<InputEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingSubmitTargetRef = useRef<ChatInputActionTarget | null | undefined>(undefined);

  const attachments = useChatAttachments(
    window.marshalRemote ? peekDraftAttachments(sessionId ?? "") : [],
  );
  useEffect(() => {
    if (window.marshalRemote && sessionId) clearDraftAttachmentTransfer(sessionId);
  }, [sessionId]);
  const {
    pendingFiles,
    contextFileAttachments,
    imageSizeWarning,
    addAttachments,
    addContextFile,
    clearContextFiles,
    removeFile,
    removeContextFile,
    handleFileSelect,
    handlePaste,
    clear: clearAttachments,
  } = attachments;

  const captureActionTarget = useCallback(
    (): ChatInputActionTarget | null => (sessionId ? { sessionId, isWaiting, isCancelling } : null),
    [sessionId, isWaiting, isCancelling],
  );

  const setInputAndEditor = useCallback((text: string) => {
    setInput(text);
    editorRef.current?.setPlainText(text);
  }, []);

  const { startTyping, cancel: cancelTypewriter } = useTypewriter(setInputAndEditor);

  const { handleArrowAtBoundary, handleEscape, clearHistory } = usePromptHistory(
    useMemo(() => userMessages.slice(-MAX_HISTORY).map(stripCtxMarkers), [userMessages]),
    setInputAndEditor,
  );

  const { data: skills = [] } = useSkills(true, sessionId ?? undefined);

  const onSessionChange = useCallback(() => {
    clearHistory();
  }, [clearHistory]);

  useDraftSync({
    sessionId,
    input,
    setInputAndEditor,
    onSessionChange,
  });

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editorRef.current?.focus(),
      setInput: (text: string) => {
        // Imperative writes should beat any in-flight typewriter drip,
        // otherwise the next rAF tick stomps the imperative value.
        cancelTypewriter();
        setInputAndEditor(text);
        editorRef.current?.focus();
      },
      startTyping: (text: string) => {
        startTyping(text);
        editorRef.current?.focus();
      },
      clearHistory,
      addContextFile,
      clearContextFiles,
      clearDraft: (targetSessionId?: string) => {
        if (targetSessionId) {
          clearDraft(targetSessionId);
          return;
        }
        clearAllDrafts();
      },
      migrateDraftToSession: (
        fromSessionId: string | null,
        toSessionId: string,
        draftText = input,
        options?: { preserveSource?: boolean },
      ) => {
        // Move mode also arms sessionDrafts' one-shot previous-save guard;
        // copy mode leaves the source draft intact for a preserved chat.
        migrateDraft(fromSessionId, toSessionId, draftText, options);
        if (window.marshalRemote)
          stageDraftAttachments(toSessionId, [...pendingFiles, ...contextFileAttachments]);
      },
      hasInput: () => Boolean(input.trim()),
      getInput: () => input,
    }),
    [
      addContextFile,
      pendingFiles,
      contextFileAttachments,
      cancelTypewriter,
      clearContextFiles,
      clearHistory,
      input,
      setInputAndEditor,
      startTyping,
    ],
  );

  useChatInputTestApi(setInputAndEditor);

  const handleEditorChange = useCallback(
    (nextValue: string) => {
      // A real user keystroke must beat any in-flight starter-prompt drip,
      // otherwise the next rAF tick overwrites what the user just typed.
      // ChangeRelayPlugin already filters out our own programmatic writes
      // (PROGRAMMATIC_UPDATE_TAG), so anything that reaches us here is a
      // genuine user-driven change.
      cancelTypewriter();
      setInput(nextValue);
    },
    [cancelTypewriter],
  );

  // Append a transcribed voice message to the current input. Appends (rather
  // than replaces) so dictation composes with any text the user already typed.
  const handleTranscript = useCallback(
    (text: string) => {
      cancelTypewriter();
      const current = editorRef.current?.getPlainText() ?? input;
      const next = current.trim() ? `${current.trimEnd()} ${text}` : text;
      setInputAndEditor(next);
      editorRef.current?.focus();
    },
    [cancelTypewriter, input, setInputAndEditor],
  );

  // Buffered on-screen reviews are delivered via a claim + ping model so a
  // submitted review is never lost if this session's composer was not mounted
  // at submit time (e.g. the user switched sessions while the overlay was open).
  const appliedReviewIds = useRef<Set<string>>(new Set());

  const applyReview = useEffectEvent((event: OverlayReviewSubmittedEvent) => {
    if (!sessionId || event.target.sessionId !== sessionId) return;
    if (appliedReviewIds.current.has(event.reviewId)) return;
    appliedReviewIds.current.add(event.reviewId);

    addAttachments(
      event.attachments.map((attachment) => ({
        path: attachment.path,
        mimeType: attachment.mimeType,
        name: attachment.name,
      })),
    );

    const summary = event.summaryMarkdown.trim();
    if (!summary) return;

    cancelTypewriter();
    const current = editorRef.current?.getPlainText() ?? input;
    const next = current.trim() ? `${current.trimEnd()}\n\n${summary}` : summary;
    setInputAndEditor(next);
    editorRef.current?.focus();
  });

  const claimReviews = useEffectEvent(() => {
    const api = window.overlayReviewAPI;
    if (!sessionId || !api?.claim) return;
    void (async () => {
      const result = await api.claim(sessionId);
      for (const event of result.reviews) applyReview(event);
    })();
  });

  // On mount and whenever the bound session changes, drain any reviews buffered
  // in main for this session, and subscribe to be woken when new ones arrive.
  useEffect(() => {
    if (!sessionId) return undefined;
    claimReviews();
    const api = window.overlayReviewAPI;
    if (!api?.onPending) return undefined;
    return api.onPending(() => claimReviews());
  }, [sessionId]);

  useEffect(() => {
    const api = window.overlayReviewAPI;
    if (!api?.onError) return undefined;
    return api.onError((event) => {
      toast.error(event.message);
    });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape" && handleEscape()) {
        e.preventDefault();
        return;
      }
      // ArrowUp/Down handled by PromptHistoryPlugin via onArrowAtBoundary.
      // Enter handled by SubmitPlugin via onEnter.
      // Slash menu (open/Arrow/Enter/Tab/Esc) handled by PickerController + PickerKeyPlugin.
    },
    [handleEscape],
  );

  const handleDragOver = (e: React.DragEvent<HTMLFormElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  // Detect drag activity at the window level so the full-screen overlay
  // appears no matter where in the app the user drags. The depth counter
  // tolerates dragenter/leave events bubbling between child elements.
  // The form itself does not register React onDragEnter/onDragLeave —
  // doing so would double-count (window listener already covers the form's
  // subtree) and amplify the chance of the overlay getting stuck.
  useEffect(() => {
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const reset = () => {
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
    };

    const onEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepthRef.current += 1;
      setIsDraggingFiles(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDraggingFiles(false);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", reset);
    // dragend fires on the source when the user cancels the drag (Esc, drops
    // outside any valid target, drops onto another OS window). Without this,
    // Chrome on Windows can omit the matching dragleave for the renderer's
    // root and leave the overlay stuck visible until the next drop.
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, []);

  const handleOverlayDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleOverlayDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    for (const file of files) {
      attachments.addFileFromFile(file);
    }
  };

  /**
   * Plain Enter (no Shift, no IME). When the slash typeahead menu is open
   * its CRITICAL-priority Enter handler runs first and consumes the key,
   * so this only fires for actual prompt submission.
   *
   * Routes through `instrumentedSubmit` so the `Send` measure fires for
   * keyboard submits too — `ChatInputActions`' `InteractiveElementMonitor_Send`
   * only covers the button click, and a Lexical contenteditable does not
   * trigger HTML form-submit-on-Enter.
   *
   * IMPORTANT: gate on `canSubmit` BEFORE calling `instrumentedSubmit`.
   * `useInteractiveElementMonitor`'s returned function emits the UserAction
   * unconditionally (the `interactionDisabled` / `hasContent` props only feed
   * the Render checkpoint, not UserAction emission — see
   * the telemetry interaction wrapper).
   * Without this guard, pressing Enter in an empty editor (or while
   * `!sdkReady` / `!sessionId`) would fire a phantom `Send` even though
   * `handleSubmit` no-ops at its validation guard — the inverse of the Enter-key Send undercount.
   * The button path doesn't need this guard because `disabled={!canSubmit}`
   * on the Send button prevents the click from ever reaching the wrapper.
   *
   * On mobile, plain Enter inserts a newline instead — the on-screen keyboard
   * makes Enter easy to hit by accident, so submission goes through the Send
   * button only. Ctrl/Cmd+Enter (steer) still works, for external keyboards.
   */
  const handleEditorEnter = (modifiers: { steer: boolean }): boolean => {
    if (isMobile && !modifiers.steer) return false;
    if (!canSubmit) return true;
    const target = captureActionTarget();
    if (target?.isWaiting && onSteer) {
      handleSteer(target);
      return true;
    }
    pendingSubmitTargetRef.current = target;
    instrumentedSubmit();
    return true;
  };

  /**
   * Intercept a leading `/goal` chat command and route it to `window.goalAPI`
   * instead of sending it to the LLM. Parses subcommands (status/help/pause/
   * resume/stop/steer/edit) and otherwise treats the whole arg as a new objective
   * (which auto-starts pursuit).
   */
  const handleGoalCommand = useCallback(
    async (commandText: string, activeSessionId: string): Promise<void> => {
      if (!window.goalAPI) {
        toast.error("Goal feature is unavailable");
        return;
      }

      const normalizedCommand = /^\/goal-status(?:\s|$)/i.test(commandText)
        ? commandText.replace(/^\/goal-status/i, "/goal status")
        : /^\/goal-edit(?:\s|$)/i.test(commandText)
          ? commandText.replace(/^\/goal-edit/i, "/goal edit")
          : commandText;
      const arg = normalizedCommand.replace(/^\/goal/i, "").trim();
      const firstWord = arg.split(/\s+/)[0] ?? "";
      const sub = firstWord.toLowerCase();
      const remainder = arg.slice(firstWord.length).trim();

      try {
        if (sub === "help") {
          toast("Usage: /goal <objective>, /goal-edit <objective>, or /goal-status");
          return;
        }
        if (sub === "status") {
          const { result, snapshot } = await fetchGoalSnapshot(activeSessionId);
          if (result.success && snapshot) {
            const view = getGoalSnapshotView(snapshot);
            const lifecycle = view.lifecycle;
            const label =
              lifecycle === "pursuing"
                ? "Pursuing"
                : lifecycle.charAt(0).toUpperCase() + lifecycle.slice(1);
            toast(`${label}: ${view.objective}`);
          } else {
            toast("No active goal. Usage: /goal <objective> to start an autonomous goal");
          }
          return;
        }
        if (sub === "pause") {
          const { snapshot } = await fetchGoalSnapshot(activeSessionId);
          if (!snapshot) throw new Error("No goal runtime snapshot is available");
          await mutateGoal({ method: "pause", expectedFence: requireGoalFence(snapshot) });
          toast.success("Goal paused");
          return;
        }
        if (sub === "resume") {
          const { snapshot } = await fetchGoalSnapshot(activeSessionId);
          if (!snapshot) throw new Error("No goal runtime snapshot is available");
          await mutateGoal({ method: "resume", expectedFence: requireGoalFence(snapshot) });
          toast.success("Goal resumed");
          return;
        }
        if (sub === "stop") {
          const { snapshot } = await fetchGoalSnapshot(activeSessionId);
          if (!snapshot) throw new Error("No goal runtime snapshot is available");
          await mutateGoal({ method: "stop", expectedFence: requireGoalFence(snapshot) });
          toast.success("Goal stopped");
          return;
        }
        if (sub === "steer") {
          if (!remainder) {
            toast("Usage: /goal steer <instruction>");
            return;
          }
          const { snapshot } = await fetchGoalSnapshot(activeSessionId);
          if (!snapshot) throw new Error("No goal runtime snapshot is available");
          await mutateGoal({
            method: "steer",
            expectedFence: requireGoalFence(snapshot),
            instruction: remainder,
          });
          toast.success("Goal steered");
          return;
        }
        if (sub === "edit") {
          if (!remainder) {
            toast("Usage: /goal-edit <new objective>");
            return;
          }
          const { snapshot } = await fetchGoalSnapshot(activeSessionId);
          if (!snapshot) throw new Error("No goal runtime snapshot is available");
          await mutateGoal({
            method: "updateDefinition",
            expectedFence: requireGoalFence(snapshot),
            patch: { objective: remainder },
          });
          toast.success("Goal updated");
          return;
        }
        await setGoal(activeSessionId, { objective: arg });
        toast.success("Pursuing goal");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Goal command failed");
      }
    },
    [mutateGoal],
  );

  const handleSubmit = (targetArg?: ChatInputActionTarget | null) => {
    // Stop any in-flight starter-prompt drip — otherwise it would keep
    // writing into the now-cleared editor on the messages view.
    cancelTypewriter();
    const pendingTarget = pendingSubmitTargetRef.current;
    pendingSubmitTargetRef.current = undefined;
    const target =
      targetArg !== undefined
        ? targetArg
        : pendingTarget !== undefined
          ? pendingTarget
          : captureActionTarget();
    const targetSessionId = target?.sessionId;
    const hasContextEntities = chips.length > 0;
    const plainText = editorRef.current?.getPlainText() ?? input;
    if (
      (!plainText.trim() && pendingFiles.length === 0 && !hasContextEntities) ||
      !sdkReady ||
      !target ||
      !targetSessionId ||
      target.isCancelling
    ) {
      return;
    }

    const finalText = flattenChipsForSubmit(plainText, chips);

    // `/goal` is a deterministic frontend command — intercept before the LLM.
    if (/^\/goal(?:-edit|-status)?(?:\s|$)/i.test(finalText.trimStart())) {
      if (/^\/goal\s*$/i.test(finalText.trim())) {
        setInputAndEditor("/goal ");
        editorRef.current?.focus();
        toast("Describe the goal after /goal, then press Enter");
        return;
      }
      void handleGoalCommand(finalText.trimStart(), targetSessionId);
      editorRef.current?.clear();
      setInput("");
      clearAttachments();
      setChips([]);
      clearDraft(targetSessionId);
      return;
    }

    onSubmit(finalText, [...pendingFiles, ...contextFileAttachments], target);
    editorRef.current?.clear();
    setInput("");
    clearAttachments();
    setChips([]);
    clearDraft(targetSessionId);
  };

  /**
   * Steer: interrupt the running turn and send the composer content right now
   * (Enter or the send button while a turn is active). Mirrors handleSubmit's
   * validation and clearing, but routes to `onSteer` instead of `onSubmit`.
   */
  const handleSteer = (target: ChatInputActionTarget | null | undefined) => {
    cancelTypewriter();
    const targetSessionId = target?.sessionId;
    const hasContextEntities = chips.length > 0;
    const plainText = editorRef.current?.getPlainText() ?? input;
    if (
      (!plainText.trim() && pendingFiles.length === 0 && !hasContextEntities) ||
      !sdkReady ||
      !target ||
      !targetSessionId ||
      target.isCancelling ||
      !onSteer
    ) {
      return;
    }

    const finalText = flattenChipsForSubmit(plainText, chips);
    // `/goal` commands are deterministic frontend commands — never steer them.
    if (/^\/goal(?:-edit|-status)?(?:\s|$)/i.test(finalText.trimStart())) {
      void handleGoalCommand(finalText.trimStart(), targetSessionId);
      editorRef.current?.clear();
      setInput("");
      clearAttachments();
      setChips([]);
      clearDraft(targetSessionId);
      return;
    }

    onSteer(finalText, [...pendingFiles, ...contextFileAttachments], target);
    editorRef.current?.clear();
    setInput("");
    clearAttachments();
    setChips([]);
    clearDraft(targetSessionId);
  };

  // Wraps `handleSubmit` with the `Send` measure so non-button submit paths
  // (form `onSubmit`, Lexical Enter) emit Send telemetry. The button in
  // `ChatInputActions` keeps its own `InteractiveElementMonitor_Send` wrapper
  // and reaches `onSubmit` through that wrapper, so button clicks still fire
  // exactly one `Send` (they do not call this hook's returned function).
  //
  // Note: `instrumentedSubmit` has a fresh function identity on every render
  // (the monitor hook does not `useCallback` its return). That's fine for both
  // current consumers: `<form onSubmit>` is a DOM prop (no memoization
  // concerns) and `handleEditorEnter` is insulated by `SubmitPlugin`'s
  // `useEffectEvent` (which is what keeps the Lexical `KEY_ENTER_COMMAND`
  // registration stable across renders). If a future call site passes
  // `instrumentedSubmit` into a `React.memo` child or a `useCallback` dep
  // array, wrap it in `useEffectEvent` to avoid silent re-render churn.
  const canSubmit =
    !attachments.isUploading &&
    sdkReady &&
    !isCancelling &&
    (Boolean(input.trim()) || pendingFiles.length > 0 || chips.length > 0);
  const instrumentedSubmit = useInteractiveElementMonitor_Send({
    hasContent: !isWaiting && !isCancelling,
    interactionDisabled: !canSubmit,
    callback: handleSubmit,
  });

  return (
    <form
      // The form stays full-bleed so its background still occludes content
      // scrolling underneath (it is absolutely positioned over the scroll
      // container on the welcome state); the child selector is what centres
      // every row on the same reading column the message list uses.
      className="relative flex flex-col items-center gap-2 bg-background p-6 *:w-full *:max-w-3xl"
      onSubmit={(event) => {
        event.preventDefault();
        pendingSubmitTargetRef.current = captureActionTarget();
        instrumentedSubmit();
      }}
      onDragOver={handleDragOver}
      data-testid="chat-input"
    >
      {isDraggingFiles &&
        (() => {
          const mainEl = document.querySelector("main");
          const overlay = (
            <div
              onDragOver={handleOverlayDragOver}
              onDrop={handleOverlayDrop}
              className="pointer-events-auto absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
              data-testid="chat-input-drop-overlay"
            >
              <p className="text-base font-medium text-foreground">Drop your files here</p>
            </div>
          );
          return mainEl ? createPortal(overlay, mainEl) : overlay;
        })()}
      {contextFileAttachments.length > 0 && (
        <AttachmentPillList files={contextFileAttachments} onRemove={removeContextFile} />
      )}
      {pendingFiles.length > 0 && <AttachmentPillList files={pendingFiles} onRemove={removeFile} />}

      {initError && (
        <DismissibleNotice
          noticeKey={`chat-init-error:${initError}`}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          dismissLabel="Dismiss chat error"
        >
          <span className="flex-1">{initError}</span>
        </DismissibleNotice>
      )}

      {imageSizeWarning && (
        <DismissibleNotice
          noticeKey={`image-size-warning:${imageSizeWarning}`}
          role="status"
          aria-live="polite"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          dismissLabel="Dismiss attachment warning"
        >
          <span className="flex-1">{imageSizeWarning}</span>
        </DismissibleNotice>
      )}

      {sessionId && <GoalWidget sessionId={sessionId} />}

      {sessionId && (
        <QueueWidget
          items={queuedMessages}
          steeringText={steeringText}
          onSteer={(id) => onSteerQueued?.(id)}
          onRemove={(id) => onRemoveQueued?.(id)}
        />
      )}

      <div
        data-testid="chat-composer-surface"
        data-mobile-collapsible={window.marshalRemote && hasUserMessages ? true : undefined}
        className="flex flex-col gap-1 rounded-[26px] border border-border/70 bg-card px-2 py-1.5 shadow-sm transition-colors focus-within:border-brand-action/45"
      >
        {header && (
          <div
            data-testid="chat-composer-header"
            inert={attachments.isUploading}
            aria-busy={attachments.isUploading}
          >
            {header}
          </div>
        )}
        <div
          data-testid="chat-composer-editor"
          className="relative flex min-w-0 items-end gap-2 px-1 py-1.5"
        >
          <PickerController
            input={input}
            editorRef={editorRef}
            skills={skills}
            setInputAndEditor={setInputAndEditor}
            workspaceName={workspaceName}
            onPickLocalFile={addContextFile}
          >
            {({
              handleKeyDown: pickerHandleKeyDown,
              menu,
              onPickerKeyIntercept,
              pickerActive,
              setAnchorEl,
              pickerListboxId,
              pickerActiveDescendantId,
            }) => (
              <>
                {menu}
                <div ref={setAnchorEl} className="flex-1" onPaste={handlePaste}>
                  <EditorWithStableKeydown
                    editorRef={editorRef}
                    initialValue={input}
                    handleEditorChange={handleEditorChange}
                    setChips={setChips}
                    pickerHandleKeyDown={pickerHandleKeyDown}
                    handleKeyDown={handleKeyDown}
                    handleArrowAtBoundary={handleArrowAtBoundary}
                    handleEditorEnter={handleEditorEnter}
                    onPickerKeyIntercept={onPickerKeyIntercept}
                    pickerActive={pickerActive}
                    pickerListboxId={pickerListboxId}
                    pickerActiveDescendantId={pickerActiveDescendantId}
                    sdkReady={sdkReady}
                    initError={initError}
                    isWaiting={isWaiting}
                    isCancelling={isCancelling}
                    customPlaceholder={customPlaceholder}
                    className="text-base/normal text-foreground"
                  />
                </div>
              </>
            )}
          </PickerController>
        </div>

        <div data-testid="chat-composer-toolbar" className="flex items-center gap-2">
          <RuntimeUiComposerActions sessionId={sessionId} workspaceName={workspaceName} />
          <ChatInputAddOns
            sessionId={sessionId}
            sdkReady={sdkReady}
            hasUserMessages={hasUserMessages}
            workspaceName={workspaceName}
            workspaceIdentity={workspaceIdentity}
            workspaceBindingInvalid={workspaceBindingInvalid}
            repositoryAgent={repositoryAgent}
            workspaceRoleDisabled={!sessionContextReady}
            onWorkspaceRoleChange={
              onWorkspaceRoleChange
                ? (selection) =>
                    onWorkspaceRoleChange(selection, {
                      hasUserMessages,
                      soulId: currentSoulId,
                    })
                : undefined
            }
            soulContextReady={soulContextReady}
            onSoulChange={onSoulChange}
            hideAttachments={hideAttachments}
            onPickFile={() => fileInputRef.current?.click()}
            onTranscript={handleTranscript}
          />

          <ChatInputActions
            sessionId={sessionId}
            sdkReady={sdkReady}
            isWaiting={isWaiting}
            isCancelling={isCancelling}
            hasContent={Boolean(input.trim()) || pendingFiles.length > 0 || chips.length > 0}
            showTokenCount={!input.trim()}
            currentTokens={currentTokens}
            tokenLimit={tokenLimit}
            inputTokens={inputTokens}
            canSubmit={canSubmit}
            onSubmit={handleSubmit}
            onStop={onStop}
            onSteer={handleSteer}
          />
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileSelect}
        className="hidden"
        data-testid="chat-file-input"
      />
    </form>
  );
}
import { RuntimeUiComposerActions } from "@/features/runtime-ui/RuntimeUiComposerActions";
