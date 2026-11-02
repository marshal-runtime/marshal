import { isAuthError } from "@common/foundation/auth/auth-errors";
import { formatErrorForDisplay } from "@common/foundation/errors/error-format";
import type { MainSessionContextSelection } from "@common/marshal-ipc-contract";
import { createLogger } from "@common/marshal-logger";
import { MARSHAL_RUNTIME_DEFAULT_WORKSPACE, RUNTIME_UI_PLACEMENT } from "@common/runtime-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useImperativeHandle,
  useSyncExternalStore,
  type Ref,
  type UIEvent,
  type WheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useStickToBottom } from "use-stick-to-bottom";

import { Button } from "@/components/marshal-ui/marshal-button";
import { DismissibleNotice } from "@/components/ui/dismissible-notice";
import { useRuntimeUiPlacement } from "@/features/runtime-ui/RuntimeUiPlacements";
import { copilotService } from "@/services/copilot";
import {
  TelemetryPath_Chat,
  TelemetryPath_Input,
  TelemetryPath_Message,
  TelemetryPath_Messages,
} from "@/services/telemetry/schema";
import type { SessionMessage } from "@/types/electron";

import {
  parseSlashInvocation,
  SLASH_PLACEMENT_ARGUMENT_KEY,
  SLASH_PLACEMENT_FRESH_KEY,
  SLASH_PLACEMENT_IDEMPOTENCY_PREFIX,
} from "../context-picker/slash-commands";
import { useMessageQueue } from "../hooks/useMessageQueue";
import { usePermissions } from "../hooks/usePermissions";
import { useSessionViewControls } from "../hooks/useSessionView";
import { useSouls } from "../hooks/useSouls";
import { useTimeline } from "../hooks/useTimeline";
import { useSessionHydration } from "../session-state/use-session-hydration";
import {
  appendToMessageWindow,
  isTranscriptHeld,
  calculatePrependScrollTop,
  CHAT_MESSAGE_WINDOW_SIZE,
  prependToMessageWindow,
  trimMessageWindow,
  type PrependScrollSnapshot,
} from "../state/messageWindow";
import {
  classifyTimelineMessage,
  isTimelineFilterActive,
  loadTimelineFilterState,
  persistTimelineFilterState,
  type TimelineFilterState,
} from "../state/timelineFilters";
import {
  forgetQueuedUnsent,
  getUnsentSnapshot,
  isMessageDelivered,
  markUnsentFailed,
  pruneDeliveredUnsent,
  recordUnsent,
  removeUnsent,
  subscribeUnsent,
  visibleUnsentMessages,
  type VisibleUnsentMessage,
} from "../state/unsentMessages";
import type { SessionData } from "../types";
import { ChatInput, type ChatInputRef, type FileAttachment } from "./ChatInput";
import type { ChatInputActionTarget } from "./ChatInputActions";
import { type Message } from "./ChatMessage";
import { ChatSkeleton } from "./ChatSkeleton";
import { dismissChatNotice, getDismissedChatNoticeKeys } from "./dismissed-chat-notices";
import { LiveTurn } from "./LiveTurn";
import { PermissionDecisionTray } from "./PermissionDecisionTray";
import { Timeline } from "./Timeline";
import { TimelineFilters } from "./TimelineFilters";
import { UnsentMessages } from "./UnsentMessages";
import { useChatScrollHold } from "./useChatScrollHold";
import { WelcomeState } from "./WelcomeState";

const EMPTY_MESSAGES: Message[] = [];
const MESSAGE_PAGE_SIZE = CHAT_MESSAGE_WINDOW_SIZE;

const log = createLogger("ChatPanel");

/** Renderer-side message id. Shared between the optimistic update and the
 *  IPC send so peer windows' useSessionView can dedupe by id when the
 *  broadcast comes back. */
function makeMessageId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function toChatMessage(message: SessionMessage): Message {
  return {
    ...message,
    timestamp: new Date(message.timestamp),
    optimistic: false,
  };
}

function reconcileFetchedSessionData(
  existing: SessionData | undefined,
  fetched: SessionData,
  transcriptHeld: boolean,
): SessionData {
  const preservingExpandedHistory = (existing?.messages.length ?? 0) > CHAT_MESSAGE_WINDOW_SIZE;
  const merged = appendToMessageWindow(existing?.messages ?? EMPTY_MESSAGES, fetched.messages, {
    preserveLoadedHistory: preservingExpandedHistory || transcriptHeld,
  });
  const messages =
    transcriptHeld ||
    (preservingExpandedHistory && merged.addedCount === 0 && merged.replacedCount === 0)
      ? merged.messages
      : trimMessageWindow(merged.messages);
  const trimmedCount = merged.trimmedCount + merged.messages.length - messages.length;
  const totalMessages = Math.max(
    existing?.totalMessages ?? existing?.messages.length ?? 0,
    fetched.totalMessages ?? fetched.messages.length,
    messages.length,
  );
  return {
    ...fetched,
    messages,
    hasOlderMessages:
      trimmedCount > 0 ||
      (messages.length < totalMessages &&
        (existing?.hasOlderMessages === true || fetched.hasOlderMessages === true)),
    totalMessages,
  };
}

function messageWindowChanged(previous: Message[], next: Message[]): boolean {
  return (
    previous.length !== next.length || next.some((message, index) => message !== previous[index])
  );
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "name") === "AbortError";
}

function isOrdinaryUserMessage(message: Message): boolean {
  return classifyTimelineMessage(message).categories.includes("user");
}

function findTimelineAnchor(
  scrollElement: HTMLElement,
  messageId?: string,
): { messageId: string; top: number } | null {
  const messages = scrollElement.querySelectorAll<HTMLElement>("[data-message-id]");
  const message =
    messageId === undefined
      ? messages.item(0)
      : Array.from(messages).find((candidate) => candidate.dataset.messageId === messageId);
  const anchorMessageId = message?.dataset.messageId;
  return message && anchorMessageId
    ? { messageId: anchorMessageId, top: message.getBoundingClientRect().top }
    : null;
}

export interface ChatPanelProps {
  ref?: Ref<ChatPanelRef>;
  sessionId?: string | null;
  pendingSkill?: string | null;
  welcomeContent?: React.ReactNode;
  timelineToolbarTarget?: HTMLElement | null;
  composerHeader?: (context: {
    ready: boolean;
    workspaceName?: string;
    hasUserMessages: boolean;
    isWaiting: boolean;
  }) => React.ReactNode;
  runtimeUiInline?: React.ReactNode;
  hideAvatars?: boolean;
  hideAttachments?: boolean;
  hideTokenCounter?: boolean;
  inputPlaceholder?: string;
  onSkillInserted?: () => void;
  onSoulChange?: (soulId: string, selection?: MainSessionContextSelection) => void;
  onWorkspaceRoleChange?: (
    selection: MainSessionContextSelection,
    context: { hasUserMessages: boolean; soulId?: string },
  ) => Promise<void>;
  onConnectionChange?: (connected: boolean) => void;
  onAuthError?: (error: string) => void;
}

export interface ChatPanelRef {
  clearChat: () => void;
  focusInput: () => void;
  hasInput: () => boolean;
  getInput: () => string;
  addContextFile: (filePath: string) => void;
  clearContextFiles: () => void;
  clearDraft: (sessionId?: string) => void;
  migrateDraftToSession: (
    fromSessionId: string | null,
    toSessionId: string,
    draftText?: string,
    options?: { preserveSource?: boolean },
  ) => void;
}

export function ChatPanel({
  ref,
  sessionId,
  pendingSkill,
  welcomeContent,
  composerHeader,
  timelineToolbarTarget,
  runtimeUiInline,
  hideAvatars,
  hideAttachments,
  hideTokenCounter,
  inputPlaceholder,
  onSkillInserted,
  onSoulChange,
  onWorkspaceRoleChange,
  onConnectionChange,
  onAuthError,
}: ChatPanelProps) {
  const queryClient = useQueryClient();
  const slashPlacement = useRuntimeUiPlacement(RUNTIME_UI_PLACEMENT.CHAT_SLASH_COMMAND);

  const { isHydrating } = useSessionHydration(sessionId ?? null);

  const [sdkReady, setSdkReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [dismissedNoticeKeys, setDismissedNoticeKeys] = useState<Set<string>>(
    () => new Set(getDismissedChatNoticeKeys()),
  );
  const [stopPendingSessionIds, setStopPendingSessionIds] = useState<Set<string>>(() => new Set());
  const stopPromisesRef = useRef(new Map<string, Promise<void>>());
  const [olderMessagesPendingBySession, setOlderMessagesPendingBySession] = useState<
    Record<string, number>
  >({});
  const timelineFilterKey = sessionId ? `session:${sessionId}` : "session:<new>";
  const [timelineFiltersBySession, setTimelineFiltersBySession] = useState<
    Record<string, TimelineFilterState>
  >({});
  const persistedTimelineFilter = useMemo(() => loadTimelineFilterState(sessionId), [sessionId]);
  const timelineFilter = timelineFiltersBySession[timelineFilterKey] ?? persistedTimelineFilter;
  const setTimelineFilter = useCallback(
    (filter: TimelineFilterState) => {
      setTimelineFiltersBySession((current) => ({ ...current, [timelineFilterKey]: filter }));
      persistTimelineFilterState(sessionId, filter);
    },
    [sessionId, timelineFilterKey],
  );
  const [retainedScrollAnchor, setRetainedScrollAnchor] = useState<{
    sessionId: string;
    messageId: string;
  } | null>(null);
  const retainedScrollAnchorMessageId =
    retainedScrollAnchor && retainedScrollAnchor.sessionId === sessionId
      ? retainedScrollAnchor.messageId
      : null;
  const previousScrollTopRef = useRef<number | null>(null);
  const olderPageScrollRef = useRef<PrependScrollSnapshot | null>(null);
  const olderMessagesRequestSequenceRef = useRef(0);
  const activeOlderMessagesRequestsRef = useRef(new Map<string, number>());
  const optimisticMessagesRef = useRef(new Map<string, Message[]>());
  const [optimisticMessagesBySession, setOptimisticMessagesBySession] = useState(
    () => new Map<string, Message[]>(),
  );
  const currentSessionIdRef = useRef(sessionId);
  const allowScrollPagingRef = useRef(false);
  const olderMessagesPending =
    sessionId !== null &&
    sessionId !== undefined &&
    olderMessagesPendingBySession[sessionId] !== undefined;

  // --- Queue / Steer ---
  // Per-session message queue: messages submitted while a turn is running are
  // held here and drained one-at-a-time when the session goes idle.
  const {
    queue,
    enqueue: enqueueLive,
    removeItem: removeLiveItem,
    clearSession: clearLiveSession,
  } = useMessageQueue(sessionId ?? null);
  // Queued messages are mirrored into the unsent store so a reload before the
  // queue drains still leaves them visible and retryable.
  const enqueue = useCallback(
    (targetSessionId: string, text: string, files: FileAttachment[]) => {
      const item = enqueueLive(targetSessionId, text, files);
      recordUnsent({ id: item.id, sessionId: targetSessionId, text, files, status: "queued" });
      return item;
    },
    [enqueueLive],
  );
  const removeItem = useCallback(
    (targetSessionId: string, id: string) => {
      removeLiveItem(targetSessionId, id);
      removeUnsent(id);
    },
    [removeLiveItem],
  );
  const clearSession = useCallback(
    (targetSessionId: string) => {
      clearLiveSession(targetSessionId);
      forgetQueuedUnsent(targetSessionId);
    },
    [clearLiveSession],
  );
  const unsentEntries = useSyncExternalStore(subscribeUnsent, getUnsentSnapshot);
  const [steeringTextBySession, setSteeringTextBySession] = useState<Record<string, string>>({});
  const steeringText = sessionId ? (steeringTextBySession[sessionId] ?? null) : null;
  // Held from the moment a queued/steer send is issued until the resulting turn
  // is observed running (or a timeout). Prevents the drain effect from firing a
  // second send before the first turn actually starts. See useMessageQueue.
  const drainLocksRef = useRef<Set<string>>(new Set());
  const lockTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // --- Session view (passive: main process owns state) ---
  const view = useSessionViewControls(sessionId ?? null);
  const isWaiting = view.status === "submitted" || view.status === "streaming";
  const isCancelling =
    (sessionId ? stopPendingSessionIds.has(sessionId) : false) ||
    view.sessionStatus === "Cancelling...";

  // --- Soul queries (shared cache with SoulPicker) ---
  const { defaultSoul, sessionSoul, isReady: soulContextReady } = useSouls(sessionId);

  const currentSoulId = sessionSoul || defaultSoul;

  const chatInputRef = useRef<ChatInputRef>(null);

  const updateOptimisticMessages = useCallback(
    (targetSessionId: string, update: (messages: Message[]) => Message[]) => {
      const current = optimisticMessagesRef.current.get(targetSessionId) ?? EMPTY_MESSAGES;
      const next = update(current);
      if (next === current) return;
      const nextBySession = new Map(optimisticMessagesRef.current);
      if (next.length === 0) {
        nextBySession.delete(targetSessionId);
      } else {
        nextBySession.set(targetSessionId, next);
      }
      optimisticMessagesRef.current = nextBySession;
      setOptimisticMessagesBySession(nextBySession);
    },
    [],
  );

  const {
    cards: permissionCards,
    respond: permissionRespond,
    clear: permissionClear,
  } = usePermissions(sessionId ?? null);

  // --- Session query ---
  const queryEnabled = !!sessionId && !!window.sessionsAPI;
  const {
    data: sessionData,
    isSuccess,
    isPending: historyPending,
    error: historyError,
    refetch: retryHistory,
  } = useQuery<SessionData>({
    queryKey: ["session", sessionId],
    staleTime: 0, // Always refetch on remount for fresh data
    queryFn: async ({ client }) => {
      const result = await window.sessionsAPI.get(sessionId!, { messageLimit: MESSAGE_PAGE_SIZE });
      if (!result.success || !result.session) {
        throw new Error(result.error ?? "This conversation could not be loaded. Please retry.");
      }
      const fetched: SessionData = {
        messages: trimMessageWindow(result.session.messages.map(toChatMessage)),
        isBusy: !!result.isBusy,
        soul: result.session.soul,
        workspaceName: result.session.workspaceName,
        workspaceIdentity: result.session.workspaceIdentity,
        workspaceBindingInvalid: result.session.workspaceBindingInvalid,
        repositoryAgent: result.session.repositoryAgent,
        permissionCards: result.session.permissionCards || [],
        turnState: null,
        hasOlderMessages: result.messagePage?.hasMore ?? false,
        totalMessages: result.messagePage?.total,
      };
      return reconcileFetchedSessionData(
        client.getQueryData<SessionData>(["session", sessionId]),
        fetched,
        isTranscriptHeld(sessionId!),
      );
    },
    enabled: queryEnabled,
  });
  // When query is disabled (no sessionId), treat as loaded immediately
  const isLoaded = !queryEnabled || isSuccess;

  const optimisticMessages = sessionId
    ? (optimisticMessagesBySession.get(sessionId) ?? EMPTY_MESSAGES)
    : EMPTY_MESSAGES;
  const messages = useMemo(
    () =>
      appendToMessageWindow(sessionData?.messages ?? EMPTY_MESSAGES, optimisticMessages, {
        preserveLoadedHistory: true,
      }).messages,
    [optimisticMessages, sessionData?.messages],
  );
  const hasOlderMessages = sessionData?.hasOlderMessages === true;
  const tokenUsage = view.tokenUsage
    ? { current: view.tokenUsage.currentTokens, limit: view.tokenUsage.tokenLimit }
    : null;

  const userMessageContents = useMemo(
    () => messages.filter(isOrdinaryUserMessage).map((m) => m.content),
    [messages],
  );

  // `initial: "instant"` puts the view at the bottom when a session loads, matching
  // prior behavior for already-populated sessions. Growth detection (RO on contentRef),
  // user-scroll-up pause, scroll-back resume, and velocity-based smooth animation
  // are all handled by the library, except that useChatScrollHold decides when a
  // reader who scrolled up is followed again.
  const scrollHold = useChatScrollHold(sessionId ?? null);
  const {
    scrollRef: messagesContainerRef,
    contentRef: messagesContentRef,
    scrollToBottom: resetAutoScroll,
  } = useStickToBottom({ initial: "instant", targetScrollTop: scrollHold.targetScrollTop });

  // --- Clear text selection when switching sessions ---
  useEffect(() => {
    currentSessionIdRef.current = sessionId;
    window.getSelection()?.removeAllRanges();
    previousScrollTopRef.current = null;
    olderPageScrollRef.current = null;
    allowScrollPagingRef.current = false;
  }, [sessionId]);

  // Let the initial bottom snap settle before treating top-of-scroll events as
  // user intent. Without this guard, initial/programmatic scroll events at
  // scrollTop=0 can recursively page the entire conversation on load.
  useEffect(() => {
    if (!isLoaded || !sessionId) return undefined;
    allowScrollPagingRef.current = false;
    previousScrollTopRef.current = null;
    const timer = window.setTimeout(() => {
      const el = messagesContainerRef.current;
      previousScrollTopRef.current = el?.scrollTop ?? null;
      allowScrollPagingRef.current = true;
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isLoaded, messagesContainerRef, sessionId]);

  // --- Auto-focus input after session load ---

  useEffect(() => {
    if (!isLoaded || !sessionId) return;
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body || active.closest('[data-testid="chat-panel"]')) {
        chatInputRef.current?.focus();
      }
    }, 0);
  }, [isLoaded, sessionId]);

  // --- Refetch session data on metadata changes ---
  // Skipped while a send is in flight so the refetch cannot clobber the
  // optimistic user message that carries fileNames/images.
  const sendInFlightBySessionRef = useRef(new Map<string, number>());
  const markSendInFlight = useCallback((targetSessionId: string, inFlight: boolean) => {
    const current = sendInFlightBySessionRef.current.get(targetSessionId) ?? 0;
    const next = inFlight ? current + 1 : Math.max(0, current - 1);
    if (next === 0) {
      sendInFlightBySessionRef.current.delete(targetSessionId);
    } else {
      sendInFlightBySessionRef.current.set(targetSessionId, next);
    }
  }, []);
  useEffect(() => {
    if (!sessionId || !window.sessionsAPI?.onMetadataChanged) return undefined;
    return window.sessionsAPI.onMetadataChanged((changedId: string) => {
      if (changedId !== sessionId) return;
      if ((sendInFlightBySessionRef.current.get(sessionId) ?? 0) > 0) return;
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    });
  }, [sessionId, queryClient]);

  // --- Send mutation ---
  const sendMutation = useMutation({
    mutationFn: async ({
      targetSessionId,
      text,
      attachments: rawAttachments,
      files,
      clientMessageId,
      steer,
    }: {
      targetSessionId: string;
      text: string;
      attachments?: Array<{ type: "file" | "directory"; path: string; displayName: string }>;
      files?: FileAttachment[];
      /** Shared with the optimistic message so the peer-window broadcast dedupes by id. */
      clientMessageId: string;
      steer?: boolean;
    }) => {
      // Process images inside mutationFn so onMutate fires immediately
      // (before any async saveImage work).
      const attachments = rawAttachments ? [...rawAttachments] : [];
      if (files?.length) {
        for (const f of files) {
          if (f.dataUrl) {
            const base64 = f.dataUrl.split(",")[1];
            // eslint-disable-next-line no-await-in-loop -- sequential to avoid filename collisions in saveImage
            const filePath = await copilotService.saveImage(base64, f.mimeType);
            attachments.push({ type: "file", path: filePath, displayName: f.name });
          } else if (f.path) {
            attachments.push({ type: "file", path: f.path, displayName: f.name });
          }
        }
      }
      const result = await (steer ? copilotService.steer : copilotService.send)(
        text,
        targetSessionId,
        attachments.length > 0 ? attachments : undefined,
        clientMessageId,
      );
      return result;
    },
    onMutate: ({ targetSessionId, text, files, clientMessageId, steer }) => {
      markSendInFlight(targetSessionId, true);
      // Persist before sending: the composer is already cleared, so this is
      // the only copy if the send fails or the page reloads mid-send.
      recordUnsent({
        id: clientMessageId,
        sessionId: targetSessionId,
        text,
        files: files ?? [],
        status: "sending",
      });
      if (steer) return { optimisticMessageId: undefined };
      const userMessage: Message = {
        id: clientMessageId,
        clientMessageId,
        role: "user",
        content: text,
        timestamp: new Date(),
        images: files?.filter((f) => f.dataUrl).map((f) => f.dataUrl!) ?? [],
        fileNames: files?.filter((f) => !f.dataUrl).map((f) => f.name) ?? [],
        optimistic: true,
      };
      updateOptimisticMessages(
        targetSessionId,
        (current) => appendToMessageWindow(current, [userMessage]).messages,
      );
      queryClient.setQueryData<SessionData>(["session", targetSessionId], (old) =>
        old
          ? (() => {
              const merged = appendToMessageWindow(old.messages, [userMessage], {
                preserveLoadedHistory: isTranscriptHeld(targetSessionId),
              });
              return {
                ...old,
                messages: merged.messages,
                hasOlderMessages: old.hasOlderMessages === true || merged.trimmedCount > 0,
                totalMessages:
                  Math.max(old.totalMessages ?? 0, old.messages.length) + merged.addedCount,
              };
            })()
          : old,
      );
      return { optimisticMessageId: clientMessageId };
    },
    onSuccess: (_data, variables) => {
      removeUnsent(variables.clientMessageId);
    },
    onError: async (error, variables, context) => {
      // send resolves when the turn ends, so an error can arrive after the
      // message was committed (turn failure, dropped connection). Only a
      // message the session does not contain is marked as not sent.
      const aborted = isAbortError(error);
      const delivered =
        !aborted &&
        (await isMessageDelivered(variables.targetSessionId, variables.clientMessageId));
      if (aborted || delivered) removeUnsent(variables.clientMessageId);
      else markUnsentFailed(variables.clientMessageId, formatErrorForDisplay(error));
      if (delivered) {
        void queryClient.invalidateQueries({ queryKey: ["session", variables.targetSessionId] });
      }
      if (context?.optimisticMessageId && !delivered) {
        updateOptimisticMessages(variables.targetSessionId, (current) =>
          current.filter((message) => message.id !== context.optimisticMessageId),
        );
        queryClient.setQueryData<SessionData>(["session", variables.targetSessionId], (old) => {
          if (!old) return old;
          const remainingMessages = old.messages.filter(
            (message) => message.id !== context.optimisticMessageId || message.optimistic !== true,
          );
          if (remainingMessages.length === old.messages.length) return old;
          return {
            ...old,
            messages: remainingMessages,
            totalMessages: Math.max(
              remainingMessages.length,
              (old.totalMessages ?? old.messages.length) -
                (old.messages.length - remainingMessages.length),
            ),
          };
        });
      }
      // Undelivered sends show their error on the unsent bubble; auth errors are
      // handled by the per-call onError (shows banner, not chat message).
      if (!delivered || isAuthError(error)) return;
      const formattedError = formatErrorForDisplay(error);
      queryClient.setQueryData<SessionData>(["session", variables.targetSessionId], (old) =>
        old
          ? (() => {
              const merged = appendToMessageWindow(
                old.messages,
                [
                  {
                    id: Date.now().toString(),
                    role: "assistant" as const,
                    content: `Error: ${formattedError}`,
                    timestamp: new Date(),
                  },
                ],
                { preserveLoadedHistory: isTranscriptHeld(variables.targetSessionId) },
              );
              return {
                ...old,
                messages: merged.messages,
                hasOlderMessages: old.hasOlderMessages === true || merged.trimmedCount > 0,
                totalMessages:
                  Math.max(old.totalMessages ?? 0, old.messages.length) + merged.addedCount,
              };
            })()
          : old,
      );
    },
    onSettled: (_data, _error, variables) => {
      markSendInFlight(variables.targetSessionId, false);
    },
  });
  const slashPlacementMutation = useMutation({
    mutationFn: async ({
      targetSessionId,
      extensionId,
      applicationId,
      argument,
      fresh,
      workspaceName,
    }: {
      targetSessionId: string;
      extensionId: string;
      applicationId: string;
      argument: string;
      fresh: boolean;
      workspaceName: string;
    }) => {
      if (!window.runtimeUiAPI) throw new Error("Runtime UI is unavailable.");
      const result = await window.runtimeUiAPI.activatePlacement({
        sessionId: targetSessionId,
        workspaceName,
        extensionId,
        applicationId,
        idempotencyKey: `${SLASH_PLACEMENT_IDEMPOTENCY_PREFIX}-${extensionId}-${applicationId}-${Date.now()}`,
        input: {
          [SLASH_PLACEMENT_ARGUMENT_KEY]: argument,
          [SLASH_PLACEMENT_FRESH_KEY]: fresh,
        },
      });
      if (!result?.success) {
        throw new Error(result?.error.message ?? "The command could not be started.");
      }
      return result;
    },
    onError: (error) => {
      toast.error("Couldn't run command", {
        description: formatErrorForDisplay(error),
      });
    },
  });

  useEffect(() => {
    if (!sessionId) return;
    if (optimisticMessages.length === 0) return;
    queryClient.setQueryData<SessionData>(["session", sessionId], (old) => {
      if (!old) return old;
      const merged = appendToMessageWindow(old.messages, optimisticMessages, {
        preserveLoadedHistory: isTranscriptHeld(sessionId),
      });
      if (!messageWindowChanged(old.messages, merged.messages)) return old;
      return {
        ...old,
        messages: merged.messages,
        hasOlderMessages: old.hasOlderMessages === true || merged.trimmedCount > 0,
        totalMessages: Math.max(old.totalMessages ?? 0, old.messages.length) + merged.addedCount,
      };
    });
  }, [optimisticMessages, queryClient, sessionData?.messages, sessionId]);

  useEffect(() => {
    if (!sessionId || !sessionData) return;
    const committedIds = new Set(
      sessionData.messages
        .filter((message) => message.optimistic !== true)
        .flatMap((message) =>
          message.clientMessageId ? [message.id, message.clientMessageId] : [message.id],
        ),
    );
    if (committedIds.size === 0) return;
    pruneDeliveredUnsent(sessionId, committedIds);
    updateOptimisticMessages(sessionId, (current) => {
      const next = current.filter(
        (message) =>
          ![message.id, message.clientMessageId].some(
            (identity) => identity !== undefined && committedIds.has(identity),
          ),
      );
      return next.length === current.length ? current : next;
    });
  }, [sessionData, sessionId, updateOptimisticMessages]);

  // Expose clearChat method via ref
  useImperativeHandle(ref, () => ({
    clearChat: () => {
      if (sessionId) {
        activeOlderMessagesRequestsRef.current.delete(sessionId);
        updateOptimisticMessages(sessionId, () => EMPTY_MESSAGES);
        setOlderMessagesPendingBySession((current) => {
          if (current[sessionId] === undefined) return current;
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
      }
      olderPageScrollRef.current = null;
      queryClient.setQueryData<SessionData>(["session", sessionId], (old) =>
        old
          ? {
              ...old,
              messages: [],
              hasOlderMessages: false,
              totalMessages: 0,
            }
          : old,
      );
      chatInputRef.current?.clearHistory();
      if (sessionId) clearSession(sessionId);
      permissionClear();
    },
    focusInput: () => {
      chatInputRef.current?.focus();
    },
    hasInput: () => {
      return chatInputRef.current?.hasInput() ?? false;
    },
    getInput: () => chatInputRef.current?.getInput() ?? "",
    addContextFile: (filePath: string) => {
      chatInputRef.current?.addContextFile(filePath);
    },
    clearContextFiles: () => {
      chatInputRef.current?.clearContextFiles();
    },
    clearDraft: (targetSessionId?: string) => {
      chatInputRef.current?.clearDraft(targetSessionId);
    },
    migrateDraftToSession: (
      fromSessionId: string | null,
      toSessionId: string,
      draftText?: string,
      options?: { preserveSource?: boolean },
    ) => {
      chatInputRef.current?.migrateDraftToSession(fromSessionId, toSessionId, draftText, options);
    },
  }));

  // Handle pending skill insertion from sidebar
  useEffect(() => {
    if (pendingSkill) {
      chatInputRef.current?.setInput(`/${pendingSkill} `);
      onSkillInserted?.();
    }
  }, [pendingSkill, onSkillInserted]);

  // Initialize Copilot service
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        await copilotService.initialize();
        if (mounted) {
          setSdkReady(true);
          onConnectionChange?.(true);
        }
      } catch (error) {
        log.error("Failed to initialize Copilot:", error);
        if (mounted) {
          setInitError(formatErrorForDisplay(error));
          onConnectionChange?.(false);
        }
      }
    };

    void init();

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-compiler/exhaustive-deps -- mount-only effect, onConnectionChange is captured at first render
  }, []);

  const handleStop = useCallback(() => {
    if (!sessionId) return Promise.resolve();
    const targetSessionId = sessionId;
    const existing = stopPromisesRef.current.get(targetSessionId);
    if (existing) return existing;
    setStopPendingSessionIds((current) => new Set(current).add(targetSessionId));
    const cancellation = copilotService.abort(targetSessionId).catch((error: unknown) => {
      log.error("Failed to stop:", error);
      toast.error("Couldn't cancel the response", {
        description: formatErrorForDisplay(error),
      });
    });
    stopPromisesRef.current.set(targetSessionId, cancellation);
    void cancellation.then(() => {
      if (stopPromisesRef.current.get(targetSessionId) === cancellation) {
        stopPromisesRef.current.delete(targetSessionId);
      }
      setStopPendingSessionIds((current) => {
        if (!current.has(targetSessionId)) return current;
        const next = new Set(current);
        next.delete(targetSessionId);
        return next;
      });
    });
    return cancellation;
  }, [sessionId]);

  /** Arm a fallback that releases the drain lock if the turn never visibly
   *  starts (e.g. an instant or silent turn the session view never reports as
   *  submitted/streaming). The normal release path is the `isWaiting` effect. */
  const clearLockTimer = useCallback((targetSessionId: string) => {
    const timer = lockTimersRef.current[targetSessionId];
    if (!timer) return;
    clearTimeout(timer);
    delete lockTimersRef.current[targetSessionId];
  }, []);

  const setDrainLocked = useCallback(
    (targetSessionId: string, locked: boolean) => {
      if (locked) {
        drainLocksRef.current.add(targetSessionId);
        return;
      }
      drainLocksRef.current.delete(targetSessionId);
      clearLockTimer(targetSessionId);
    },
    [clearLockTimer],
  );

  const isDrainLocked = useCallback(
    (targetSessionId: string) => drainLocksRef.current.has(targetSessionId),
    [],
  );

  const setSessionSteeringText = useCallback((targetSessionId: string, text: string | null) => {
    setSteeringTextBySession((current) => {
      if (text === null) {
        if (!(targetSessionId in current)) return current;
        const next = { ...current };
        delete next[targetSessionId];
        return next;
      }
      return { ...current, [targetSessionId]: text };
    });
  }, []);

  const armLockRelease = useCallback(
    (targetSessionId: string) => {
      clearLockTimer(targetSessionId);
      lockTimersRef.current[targetSessionId] = setTimeout(() => {
        setDrainLocked(targetSessionId, false);
        setSessionSteeringText(targetSessionId, null);
      }, 8000);
    },
    [clearLockTimer, setDrainLocked, setSessionSteeringText],
  );

  /** Fire the actual send (optimistic insert + IPC). Shared by direct sends,
   *  queue drains, and steers. */
  const dispatchSend = useCallback(
    (targetSessionId: string, text: string, files: FileAttachment[], steer = false) => {
      sendMutation.mutate(
        { targetSessionId, text, files, clientMessageId: makeMessageId(), steer },
        {
          onError: (error) => {
            if (isAuthError(error) && onAuthError) {
              onAuthError(formatErrorForDisplay(error));
            }
          },
        },
      );
    },
    [onAuthError, sendMutation],
  );

  /** A send the user just made takes them to the bottom; a queue drain must not. */
  const { release: releaseScrollHold } = scrollHold;
  const sendNow = useCallback(
    (targetSessionId: string, text: string, files: FileAttachment[], steer = false) => {
      releaseScrollHold();
      void resetAutoScroll();
      dispatchSend(targetSessionId, text, files, steer);
    },
    [dispatchSend, releaseScrollHold, resetAutoScroll],
  );

  const handleInputSubmit = useCallback(
    (text: string, files: FileAttachment[], target: ChatInputActionTarget) => {
      const targetSessionId = target.sessionId;
      if (target.isCancelling) return;
      const slash = files.length === 0 ? parseSlashInvocation(text) : null;
      const application = slash
        ? slashPlacement.applications.find((candidate) => candidate.applicationId === slash.name)
        : undefined;
      if (application && slash) {
        slashPlacementMutation.mutate({
          targetSessionId,
          extensionId: application.extensionId,
          applicationId: application.applicationId,
          argument: slash.argument,
          fresh: slash.fresh,
          workspaceName: sessionData?.workspaceName?.trim() || MARSHAL_RUNTIME_DEFAULT_WORKSPACE,
        });
        return;
      }

      // While a turn is running (or a queued drain is mid-flight), hold the
      // message in the per-session queue instead of interrupting the model.
      // This replaces the old abort-on-submit ("Cancelling...") behavior.
      if (target.isWaiting || isDrainLocked(targetSessionId)) {
        enqueue(targetSessionId, text, files);
        return;
      }

      sendNow(targetSessionId, text, files);
    },
    [
      enqueue,
      isDrainLocked,
      sendNow,
      sessionData?.workspaceName,
      slashPlacement.applications,
      slashPlacementMutation,
    ],
  );

  /** Steer: interrupt the running turn and send `text` immediately. */
  const handleSteer = useCallback(
    async (text: string, files: FileAttachment[], target: ChatInputActionTarget) => {
      const targetSessionId = target.sessionId;
      // Hold the lock so the queue drain doesn't also fire during the interrupt.
      setDrainLocked(targetSessionId, true);
      setSessionSteeringText(targetSessionId, text);
      try {
        sendNow(targetSessionId, text, files, true);
      } finally {
        armLockRelease(targetSessionId);
      }
    },
    [sendNow, armLockRelease, setDrainLocked, setSessionSteeringText],
  );

  /** Send a queued item right now by steering it (interrupt + send). */
  const handleSteerQueued = useCallback(
    (id: string) => {
      if (!sessionId) return;
      const targetSessionId = sessionId;
      const item = queue.find((q) => q.id === id);
      if (!item) return;
      removeItem(targetSessionId, id);
      void handleSteer(item.text, item.files, {
        sessionId: targetSessionId,
        isWaiting,
        isCancelling,
      });
    },
    [sessionId, queue, removeItem, handleSteer, isWaiting, isCancelling],
  );

  const liveQueueIds = useMemo(() => new Set(queue.map((item) => item.id)), [queue]);
  const unsentMessages = useMemo(
    () => (sessionId ? visibleUnsentMessages(unsentEntries, sessionId, liveQueueIds) : []),
    [liveQueueIds, sessionId, unsentEntries],
  );

  const handleRetryUnsent = useCallback(
    async (message: VisibleUnsentMessage) => {
      // A dropped connection can hide a send that did reach the session;
      // check first so Retry never posts the same message twice.
      if (await isMessageDelivered(message.sessionId, message.id)) {
        removeUnsent(message.id);
        void queryClient.invalidateQueries({ queryKey: ["session", message.sessionId] });
        toast.success("This message had already been delivered");
        return;
      }
      removeUnsent(message.id);
      if (message.sessionId !== currentSessionIdRef.current) return;
      if (isWaiting || isDrainLocked(message.sessionId)) {
        enqueue(message.sessionId, message.text, message.files);
      } else {
        sendNow(message.sessionId, message.text, message.files);
      }
    },
    [enqueue, isDrainLocked, isWaiting, queryClient, sendNow],
  );

  const handleRemoveQueued = useCallback(
    (id: string) => {
      if (!sessionId) return;
      removeItem(sessionId, id);
    },
    [sessionId, removeItem],
  );

  // Release the drain lock once the just-sent turn is observed running, and
  // clear the transient steering banner. While `isWaiting` is true the drain
  // effect is blocked anyway; releasing here lets the NEXT idle transition
  // drain the following queued message.
  useEffect(() => {
    if (!isWaiting || !sessionId) return;
    // eslint-disable-next-line react-compiler/set-state-in-effect -- reacting to the backend-owned isWaiting transition to clear the transient steer banner
    setSessionSteeringText(sessionId, null);
    if (isDrainLocked(sessionId)) {
      setDrainLocked(sessionId, false);
    }
  }, [isWaiting, sessionId, isDrainLocked, setDrainLocked, setSessionSteeringText]);

  // Drain the queue one message at a time when the session is idle. The lock
  // guards against double-sending before the previous turn actually starts.
  useEffect(() => {
    if (!sessionId) return;
    if (isDrainLocked(sessionId)) return;
    if (isWaiting || isCancelling) return;
    if (!sdkReady) return;
    if (queue.length === 0) return;

    setDrainLocked(sessionId, true);
    const head = queue[0];
    // eslint-disable-next-line react-compiler/set-state-in-effect -- intentional FIFO drain: dequeue the head and send it once the session is idle
    removeItem(sessionId, head.id);
    dispatchSend(sessionId, head.text, head.files);
    armLockRelease(sessionId);
  }, [
    sessionId,
    isWaiting,
    isCancelling,
    sdkReady,
    queue,
    removeItem,
    dispatchSend,
    armLockRelease,
    isDrainLocked,
    setDrainLocked,
  ]);

  // Clean up any pending lock timer on unmount.
  useEffect(() => {
    const lockTimers = lockTimersRef.current;
    const drainLocks = drainLocksRef.current;
    return () => {
      Object.values(lockTimers).forEach((timer) => clearTimeout(timer));
      for (const targetSessionId of Object.keys(lockTimers)) {
        delete lockTimers[targetSessionId];
      }
      drainLocks.clear();
    };
  }, []);

  /** Find the last assistant message with an unresolved question (no selectedAnswer). */
  const findPendingQuestionMessage = useCallback((): Message | undefined => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.question && !m.question.selectedAnswer) return m;
      if (classifyTimelineMessage(m).renderRole === "user") break;
    }
    return undefined;
  }, [messages]);

  const setQuestionSelection = useCallback(
    (messageId: string, selectedAnswer?: string) => {
      queryClient.setQueryData<SessionData>(["session", sessionId], (old) => {
        if (!old) return old;
        return {
          ...old,
          messages: old.messages.map((m) => {
            if (m.id !== messageId || !m.question) return m;
            if (selectedAnswer === undefined) {
              const { selectedAnswer: _selectedAnswer, ...question } = m.question;
              return { ...m, question };
            }
            return { ...m, question: { ...m.question, selectedAnswer } };
          }),
        };
      });
    },
    [sessionId, queryClient],
  );

  const persistQuestionSelection = useCallback(
    async (messageId: string, selectedAnswer: string) => {
      if (!sessionId || !window.sessionsAPI?.patchQuestionSelection) {
        setQuestionSelection(messageId, undefined);
        log.error("Failed to persist question selection: sessions API unavailable");
        return false;
      }

      const result = await window.sessionsAPI.patchQuestionSelection(
        sessionId,
        messageId,
        selectedAnswer,
      );
      if (!result.success) {
        setQuestionSelection(messageId, undefined);
        log.error(
          `Failed to persist question selection [${sessionId}]: ${result.error ?? "Unknown error"}`,
        );
        return false;
      }
      return true;
    },
    [sessionId, setQuestionSelection],
  );

  /** Fold a freeform reply as "Other" on the pending question message. */
  const foldOtherAnswer = useCallback(
    (freeformText: string) => {
      const pending = findPendingQuestionMessage();
      if (!pending) return;
      const otherAnswer = `Other: ${freeformText}`;
      setQuestionSelection(pending.id, otherAnswer);
      void persistQuestionSelection(pending.id, otherAnswer);
    },
    [findPendingQuestionMessage, persistQuestionSelection, setQuestionSelection],
  );

  /** Wraps handleInputSubmit to fold freeform replies into pending questions. */
  const handleInputSubmitWithFolding = useCallback(
    async (text: string, files: FileAttachment[], target: ChatInputActionTarget) => {
      foldOtherAnswer(text);
      return handleInputSubmit(text, files, target);
    },
    [handleInputSubmit, foldOtherAnswer],
  );

  /** Handle inline question selection: mark as selected in cache + persist, then auto-submit. */
  const handleActionSelect = useCallback(
    (messageId: string, answer: string) => {
      if (!sessionId) return;
      setQuestionSelection(messageId, answer);
      void persistQuestionSelection(messageId, answer);
      handleInputSubmit(answer, [], { sessionId, isWaiting, isCancelling });
    },
    [
      handleInputSubmit,
      isCancelling,
      isWaiting,
      persistQuestionSelection,
      sessionId,
      setQuestionSelection,
    ],
  );

  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          !dismissedNoticeKeys.has(`message:${sessionId ?? "new-session"}:${message.id}`),
      ),
    [dismissedNoticeKeys, messages, sessionId],
  );
  const visiblePermissionCards = useMemo(
    () =>
      permissionCards.filter(
        (card) => !dismissedNoticeKeys.has(`permission:${sessionId ?? "new-session"}:${card.id}`),
      ),
    [dismissedNoticeKeys, permissionCards, sessionId],
  );
  const { runs, activeCards, subagents, totalEntryCount, visibleEntryCount } = useTimeline(
    visibleMessages,
    visiblePermissionCards,
    {
      constrainResolvedCards: true,
      filter: timelineFilter,
    },
  );
  const pendingDecisionCards = useMemo(
    () => activeCards.filter((card) => !card.resolved),
    [activeCards],
  );
  const dismissNotice = useCallback((noticeKey: string) => {
    dismissChatNotice(noticeKey);
    setDismissedNoticeKeys((current) => new Set(current).add(noticeKey));
  }, []);
  const dismissMessage = useCallback(
    (messageId: string) => dismissNotice(`message:${sessionId ?? "new-session"}:${messageId}`),
    [dismissNotice, sessionId],
  );
  const dismissPermission = useCallback(
    (requestId: string) => dismissNotice(`permission:${sessionId ?? "new-session"}:${requestId}`),
    [dismissNotice, sessionId],
  );

  const loadOlderMessages = useCallback(async () => {
    if (
      !sessionId ||
      activeOlderMessagesRequestsRef.current.has(sessionId) ||
      !hasOlderMessages ||
      messages.length === 0
    ) {
      return;
    }
    const beforeMessage = messages[0];
    if (!beforeMessage) return;
    const beforeMessageId = beforeMessage.id;
    const requestId = ++olderMessagesRequestSequenceRef.current;
    activeOlderMessagesRequestsRef.current.set(sessionId, requestId);
    setOlderMessagesPendingBySession((current) => ({ ...current, [sessionId]: requestId }));
    try {
      const result = await window.sessionsAPI?.getMessages?.(sessionId, {
        beforeMessageId,
        limit: MESSAGE_PAGE_SIZE,
      });
      if (!result?.success || !result.messages) {
        toast.error(result?.error ?? "Older messages could not be loaded");
        return;
      }
      const older = result.messages.map(toChatMessage);
      if (
        activeOlderMessagesRequestsRef.current.get(sessionId) !== requestId ||
        currentSessionIdRef.current !== sessionId
      ) {
        return;
      }
      const scrollElement = messagesContainerRef.current;
      const anchor = scrollElement ? findTimelineAnchor(scrollElement) : null;
      const scrollSnapshot =
        scrollElement === null
          ? null
          : {
              scrollHeight: scrollElement.scrollHeight,
              scrollTop: scrollElement.scrollTop,
              ...(anchor ? { anchorMessageId: anchor.messageId, anchorTop: anchor.top } : {}),
            };
      let prepended = false;
      queryClient.setQueryData<SessionData>(["session", sessionId], (old) => {
        if (!old) return old;
        const latest = appendToMessageWindow(
          old.messages,
          optimisticMessagesRef.current.get(sessionId) ?? EMPTY_MESSAGES,
          { preserveLoadedHistory: true },
        );
        const anchorStillLoaded = latest.messages.some((message) => message.id === beforeMessageId);
        const merged = prependToMessageWindow(
          latest.messages,
          anchorStillLoaded ? older : [...older, beforeMessage],
        );
        prepended = merged.addedCount > 0;
        const totalMessages = Math.max(
          old.totalMessages ?? old.messages.length,
          result.total ?? 0,
          merged.messages.length,
        );
        return {
          ...old,
          messages: merged.messages,
          hasOlderMessages: prepended ? (result.hasMore ?? false) : false,
          totalMessages,
        };
      });
      if (prepended && scrollSnapshot) {
        olderPageScrollRef.current = scrollSnapshot;
        if (scrollSnapshot.anchorMessageId) {
          setRetainedScrollAnchor({
            sessionId,
            messageId: scrollSnapshot.anchorMessageId,
          });
        }
      }
    } finally {
      if (activeOlderMessagesRequestsRef.current.get(sessionId) === requestId) {
        activeOlderMessagesRequestsRef.current.delete(sessionId);
      }
      setOlderMessagesPendingBySession((current) => {
        if (current[sessionId] !== requestId) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    }
  }, [hasOlderMessages, messages, messagesContainerRef, queryClient, sessionId]);

  useLayoutEffect(() => {
    const previous = olderPageScrollRef.current;
    const scrollElement = messagesContainerRef.current;
    if (!previous || !scrollElement) return;
    olderPageScrollRef.current = null;
    const nextAnchorTop = previous.anchorMessageId
      ? findTimelineAnchor(scrollElement, previous.anchorMessageId)?.top
      : undefined;
    scrollElement.scrollTop = calculatePrependScrollTop(
      previous,
      scrollElement.scrollHeight,
      nextAnchorTop,
    );
    queueMicrotask(() => {
      setRetainedScrollAnchor((current) => (current?.sessionId === sessionId ? null : current));
    });
  }, [messages, messagesContainerRef, sessionId]);

  const { handleScroll: trackHoldOnScroll, handleWheel: trackHoldOnWheel } = scrollHold;
  const handleMessagesWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (trackHoldOnWheel(event)) void resetAutoScroll();
    },
    [resetAutoScroll, trackHoldOnWheel],
  );

  const handleMessagesScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (trackHoldOnScroll(event.currentTarget)) void resetAutoScroll();
      const { scrollTop } = event.currentTarget;
      const previousScrollTop = previousScrollTopRef.current;
      previousScrollTopRef.current = scrollTop;
      if (!allowScrollPagingRef.current) return;
      const isUserScrollingUp = previousScrollTop !== null && scrollTop < previousScrollTop;
      if (isUserScrollingUp && scrollTop <= 24) void loadOlderMessages();
    },
    [loadOlderMessages, resetAutoScroll, trackHoldOnScroll],
  );

  const liveTurn =
    isWaiting || activeCards.length > 0 ? (
      <LiveTurn
        sessionId={sessionId ?? null}
        soulId={currentSoulId}
        continuesAssistantRun={runs[runs.length - 1]?.role === "assistant"}
        activeCards={activeCards}
        onRespond={permissionRespond}
        dismissedToolNoticeKeys={dismissedNoticeKeys}
        onToolNoticeDismiss={dismissNotice}
      />
    ) : undefined;

  if (isHydrating) {
    return <ChatSkeleton />;
  }

  const showWelcome =
    messages.length === 0 &&
    unsentMessages.length === 0 &&
    activeCards.length === 0 &&
    !isWaiting &&
    isLoaded;

  const sessionStatus = view.sessionStatus;
  const sessionStatusBanner = sessionStatus ? (
    <DismissibleNotice
      noticeKey={`${sessionId ?? "new-session"}:${sessionStatus}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={isWaiting || isCancelling}
      dismissLabel="Dismiss session status"
      className="mx-4 my-2 flex animate-in items-center gap-2 rounded-lg border border-border bg-muted px-4 py-2 text-sm text-muted-foreground fade-in"
    >
      {(isWaiting || isCancelling) && (
        <div className="size-3.5 animate-spin rounded-full border-2 border-border border-t-primary" />
      )}
      <span className="flex-1">{sessionStatus}</span>
    </DismissibleNotice>
  ) : null;

  return (
    <TelemetryPath_Chat>
      <div
        className="relative flex size-full flex-col overflow-hidden"
        data-testid="chat-panel"
        data-hide-avatars={hideAvatars || undefined}
        data-welcome={showWelcome ? "true" : "false"}
      >
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {queryEnabled && historyPending && !sessionData && (
            <div role="status" className="px-6 py-3 text-sm text-muted-foreground">
              Loading conversation…
            </div>
          )}
          {historyError && (
            <div role="alert" className="flex items-center gap-3 px-6 py-3 text-sm">
              <span>{historyError.message}</span>
              <button type="button" onClick={() => void retryHistory()}>
                Retry
              </button>
            </div>
          )}
          {/* Single, stable scroll container for both welcome and messages
              states. Keeping the same DOM node + ref across the welcome -> messages
              transition is required so that `useStickToBottom`'s scroll-pause
              detection isn't reset mid-conversation (which would re-snap the
              user to the bottom even after they scrolled up). */}
          <div
            className="relative flex size-full flex-col overflow-y-auto p-6 select-text [scrollbar-gutter:stable_both-edges]"
            ref={messagesContainerRef}
            onScroll={handleMessagesScroll}
            onWheel={handleMessagesWheel}
            data-testid="messages-container"
          >
            {showWelcome && (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 -z-10 overflow-hidden opacity-30 dark:opacity-25"
                data-welcome-bg
                data-testid="welcome-background"
              >
                {/* Iris glow behind the welcome screen. Inline style is the
                    deliberate exception to the Tailwind-only policy because the
                    arbitrary-value class form for a gradient this long is
                    unreadable and worse for future edits. */}
                <div
                  className="absolute top-[calc(100%+180px)] left-1/2 h-[640px] w-[1440px] -translate-x-1/2 animate-[welcome-shimmer_16s_ease-in-out_infinite] rounded-full blur-[180px]"
                  style={{
                    backgroundImage:
                      "linear-gradient(90deg, rgba(79,52,213,0.45) 0%, rgba(124,101,232,0.4) 35%, rgba(139,116,240,0.4) 65%, rgba(160,137,250,0.45) 100%)",
                  }}
                />
              </div>
            )}
            {showWelcome ? (
              <div className="flex flex-1 flex-col gap-4">{welcomeContent ?? <WelcomeState />}</div>
            ) : (
              <TelemetryPath_Messages>
                <div
                  className="mx-auto flex w-full max-w-3xl flex-col gap-4"
                  ref={messagesContentRef}
                >
                  {hasOlderMessages && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mx-auto"
                      onClick={() => void loadOlderMessages()}
                      disabled={olderMessagesPending}
                    >
                      {olderMessagesPending
                        ? "Loading previous 20 messages…"
                        : "Load previous 20 messages"}
                    </Button>
                  )}
                  <Timeline
                    runs={runs}
                    scrollRef={messagesContainerRef}
                    sessionId={sessionId}
                    soulId={currentSoulId}
                    onPermissionRespond={permissionRespond}
                    onPermissionDismiss={dismissPermission}
                    onMessageDismiss={dismissMessage}
                    dismissedToolNoticeKeys={dismissedNoticeKeys}
                    onToolNoticeDismiss={dismissNotice}
                    onActionSelect={handleActionSelect}
                    retainedAnchorMessageId={retainedScrollAnchorMessageId}
                  />
                  {isTimelineFilterActive(timelineFilter) && visibleEntryCount === 0 && (
                    <div
                      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
                      role="status"
                    >
                      No timeline entries match these filters.
                    </div>
                  )}
                  {liveTurn}
                  {isLoaded && (
                    <UnsentMessages
                      messages={unsentMessages}
                      onRetry={handleRetryUnsent}
                      onDelete={removeUnsent}
                    />
                  )}
                </div>
              </TelemetryPath_Messages>
            )}
            {runtimeUiInline}
            {sessionStatusBanner}
          </div>
        </div>

        {/* Welcome state keeps absolute positioning so typewriter expansion
            doesn't shrink the messages container and shift the centered
            welcome content. Messages state uses flex-sibling layout so the
            last message sits tight against the input. */}
        <div
          data-testid="chat-composer-region"
          className={showWelcome ? "absolute inset-x-0 bottom-0 z-10" : "shrink-0"}
        >
          {!showWelcome &&
            totalEntryCount > 0 &&
            (timelineToolbarTarget ? (
              createPortal(
                <TimelineFilters
                  compact
                  filter={timelineFilter}
                  subagents={subagents}
                  visibleCount={visibleEntryCount}
                  totalCount={totalEntryCount}
                  onChange={setTimelineFilter}
                />,
                timelineToolbarTarget,
              )
            ) : (
              <div
                className="flex shrink-0 justify-end bg-background px-6 pt-2"
                data-testid="timeline-filter-chrome"
              >
                <TimelineFilters
                  filter={timelineFilter}
                  subagents={subagents}
                  visibleCount={visibleEntryCount}
                  totalCount={totalEntryCount}
                  onChange={setTimelineFilter}
                />
              </div>
            ))}
          {pendingDecisionCards.length > 0 && (
            <TelemetryPath_Messages>
              <TelemetryPath_Message>
                <PermissionDecisionTray
                  requests={pendingDecisionCards}
                  onRespond={permissionRespond}
                />
              </TelemetryPath_Message>
            </TelemetryPath_Messages>
          )}
          <TelemetryPath_Input>
            <ChatInput
              ref={chatInputRef}
              sessionId={sessionId}
              userMessages={userMessageContents}
              isWaiting={isWaiting}
              isCancelling={isCancelling}
              sdkReady={sdkReady}
              initError={initError}
              hasUserMessages={messages.some(isOrdinaryUserMessage)}
              header={composerHeader?.({
                ready: isLoaded && soulContextReady,
                workspaceName: sessionData?.workspaceName,
                hasUserMessages: messages.some(isOrdinaryUserMessage),
                isWaiting,
              })}
              sessionContextReady={isLoaded && soulContextReady}
              soulContextReady={
                isLoaded &&
                soulContextReady &&
                !sessionData?.workspaceBindingInvalid &&
                (!sessionData?.workspaceName || !!sessionData.workspaceIdentity) &&
                (!sessionData?.repositoryAgent || !!sessionData.repositoryAgent.identity)
              }
              workspaceName={sessionData?.workspaceName}
              workspaceIdentity={sessionData?.workspaceIdentity}
              workspaceBindingInvalid={sessionData?.workspaceBindingInvalid}
              repositoryAgent={sessionData?.repositoryAgent}
              currentSoulId={currentSoulId}
              hideAttachments={hideAttachments}
              placeholder={inputPlaceholder}
              onSubmit={handleInputSubmitWithFolding}
              onStop={handleStop}
              onSteer={handleSteer}
              queuedMessages={queue}
              steeringText={steeringText}
              onRemoveQueued={handleRemoveQueued}
              onSteerQueued={handleSteerQueued}
              onSoulChange={(soulId) =>
                onSoulChange?.(soulId, {
                  workspaceBinding:
                    sessionData?.workspaceName && sessionData.workspaceIdentity
                      ? {
                          name: sessionData.workspaceName,
                          identity: sessionData.workspaceIdentity,
                        }
                      : undefined,
                  repositoryAgent: sessionData?.repositoryAgent,
                })
              }
              onWorkspaceRoleChange={onWorkspaceRoleChange}
              currentTokens={hideTokenCounter ? undefined : tokenUsage?.current}
              tokenLimit={hideTokenCounter ? undefined : tokenUsage?.limit}
              inputTokens={hideTokenCounter ? undefined : view.lastTurnUsage?.inputTokens}
            />
          </TelemetryPath_Input>
        </div>
      </div>
    </TelemetryPath_Chat>
  );
}
