import type { GoalRecord, GoalRuntimeSnapshot } from "@common/goal-contract";
import userEvent from "@testing-library/user-event";
import { createRef, type ComponentProps, type ReactNode } from "react";
import { toast } from "sonner";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installMockAPIs, render, screen, waitFor, act } from "@/test-utils";
import type {
  GoalAPI,
  OverlayReviewAPI,
  OverlayReviewSubmittedEvent,
  SkillsAPI,
} from "@/types/electron";

import {
  getPromptEditor,
  pressInPromptEditor,
  promptEditorText,
  setPromptTextDOM,
} from "../testing/prompt-editor-dom";
import { clearPromptText, setPromptText } from "../testing/prompt-editor-ref";
import { ChatInput, type ChatInputRef, _clearSessionDrafts } from "./ChatInput";

type ChatInputProps = ComponentProps<typeof ChatInput>;

// Mock unrelated children so skills-loading tests stay focused.
vi.mock("./ModelPicker", () => ({
  ModelPicker: ({ disabled }: { disabled?: boolean }) => (
    <div data-testid="model-picker" data-disabled={String(!!disabled)} />
  ),
  ModelSelectionLabel: () => null,
}));
vi.mock("./WorkspaceRolePicker", () => ({
  WorkspaceRolePicker: ({
    disabled,
    hasUserMessages,
    soulContextReady,
    onSoulChange,
  }: {
    disabled?: boolean;
    hasUserMessages?: boolean;
    soulContextReady?: boolean;
    onSoulChange?: (soulId: string) => void;
  }) => (
    <>
      <button data-testid="workspace-role-picker" disabled={disabled} />
      {onSoulChange && (
        <button data-testid="soul-picker" disabled={!soulContextReady || hasUserMessages} />
      )}
    </>
  ),
}));
vi.mock("../editor/pills/SelectableInlinePill", () => ({
  InlinePillDecorator: ({ children, className }: { children: ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));
vi.mock("sonner", () => ({
  toast: {
    error: vi.fn<(message: string) => void>(),
  },
}));
// Render pills directly to avoid ResizeObserver, offsetWidth, and icon issues in tests.
vi.mock("./AttachmentPillList", () => ({
  AttachmentPillList: ({
    files,
    onRemove,
  }: {
    files: Array<{ name: string; dataUrl?: string }>;
    onRemove: (index: number) => void;
  }) => (
    <div data-testid="pill-list-container">
      {files.map((f: { name: string }, i: number) => (
        <div key={f.name} data-testid="attachment-pill">
          {f.name}
          <button onClick={() => onRemove(i)}>Remove {f.name}</button>
        </div>
      ))}
    </div>
  ),
}));

const defaultProps = {
  sessionId: "test-session",
  userMessages: [] as string[],
  isWaiting: false,
  sdkReady: true,
  initError: null,
  hasUserMessages: false,
  onSubmit: vi.fn<(text: string) => void>(),
  onStop: vi.fn<() => void>(),
};

const sampleSkills = [
  {
    id: "s1",
    name: "summarize",
    description: "Summarize text",
    instructions: "",
    enabled: true,
    createdAt: "2025-01-01",
    scope: "local" as const,
  },
  {
    id: "s2",
    name: "translate",
    description: "Translate text",
    instructions: "",
    enabled: true,
    createdAt: "2025-01-01",
    scope: "global" as const,
  },
  {
    id: "s3",
    name: "disabled-skill",
    description: "Should not appear",
    instructions: "",
    enabled: false,
    createdAt: "2025-01-01",
    scope: "local" as const,
  },
];

describe("ChatInput — skills data-loading surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: sampleSkills }),
      },
    });
  });

  it("calls window.skillsAPI.list() on mount", async () => {
    render(<ChatInput {...defaultProps} />);

    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps model and reasoning controls enabled after messages", async () => {
    const user = userEvent.setup();
    render(<ChatInput {...defaultProps} hasUserMessages />);

    await user.click(screen.getByRole("button", { name: "Models" }));

    const picker = await screen.findByTestId("model-picker");
    expect(picker).toHaveAttribute("data-disabled", "false");
  });

  it("keeps workspace and soul controls disabled until session context is ready", () => {
    render(
      <ChatInput
        {...defaultProps}
        sessionContextReady={false}
        onWorkspaceRoleChange={async () => undefined}
        onSoulChange={() => undefined}
      />,
    );

    expect(screen.getByTestId("workspace-role-picker")).toBeDisabled();
    expect(screen.getByTestId("soul-picker")).toBeDisabled();
  });

  it("shows skill autocomplete suggestions when '/' is typed", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "/");

    await waitFor(() => {
      expect(screen.getByText("/summarize")).toBeInTheDocument();
      expect(screen.getByText("/translate")).toBeInTheDocument();
    });
  });

  it("only shows enabled skills in autocomplete", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "/");

    await waitFor(() => {
      expect(screen.getByText("/summarize")).toBeInTheDocument();
    });

    expect(screen.queryByText("/disabled-skill")).not.toBeInTheDocument();
  });

  it("filters skill suggestions by typed query after '/'", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "/sum");

    await waitFor(() => {
      expect(screen.getByText("/summarize")).toBeInTheDocument();
    });

    expect(screen.queryByText("/translate")).not.toBeInTheDocument();
  });

  it("shows Global badge for global-scoped skills", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "/");

    await waitFor(() => {
      expect(screen.getByText("Global")).toBeInTheDocument();
    });
  });

  it("does not show autocomplete when input does not start with '/'", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "hello");

    expect(screen.queryByText("/summarize")).not.toBeInTheDocument();
  });

  it("hides autocomplete when input has a space after the slash command", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "/sum");
    expect(screen.getByText("Summarize text")).toBeInTheDocument();

    await setPromptText(ref, "/summarize ");
    expect(screen.queryByText("Summarize text")).not.toBeInTheDocument();
  });
});

describe("ChatInput — overlay review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
    });
  });

  it("claims and applies a buffered multi-frame review with attachments and combined summary", async () => {
    let firePending: ((event: { sessionId: string }) => void) | undefined;
    const review: OverlayReviewSubmittedEvent = {
      reviewId: "review-1",
      target: { sessionId: "test-session", isNew: false },
      attachments: [
        {
          name: "review-frame-1-display-1.png",
          mimeType: "image/png",
          path: "C:\\Temp\\review-frame-1-display-1.png",
          kind: "screenshot",
        },
        {
          name: "review-frame-1-display-1-marked.png",
          mimeType: "image/png",
          path: "C:\\Temp\\review-frame-1-display-1-marked.png",
          kind: "composite",
        },
        {
          name: "review-frame-2-display-1.png",
          mimeType: "image/png",
          path: "C:\\Temp\\review-frame-2-display-1.png",
          kind: "screenshot",
        },
        {
          name: "review-frame-2-display-1-marked.png",
          mimeType: "image/png",
          path: "C:\\Temp\\review-frame-2-display-1-marked.png",
          kind: "composite",
        },
        {
          name: "review-frame-2-voice-note-1-pin-2.webm",
          mimeType: "audio/webm",
          path: "C:\\Temp\\review-frame-2-voice-note-1-pin-2.webm",
          kind: "audio",
        },
      ],
      summaryMarkdown:
        "# Screen review\n\n## Frame 1\n- Move the CTA above the fold.\n\n## Frame 2\n- Keep the modal centered after resize.",
    };
    // Empty on the mount drain, then returns the review when woken by a ping.
    const claim = vi
      .fn<OverlayReviewAPI["claim"]>()
      .mockResolvedValueOnce({ reviews: [] })
      .mockResolvedValue({ reviews: [review] });
    const onPending = vi.fn<OverlayReviewAPI["onPending"]>((callback) => {
      firePending = callback;
      return () => {};
    });
    installMockAPIs({
      overlayReviewAPI: { claim, onPending },
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
    });

    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);
    await waitFor(() => expect(claim).toHaveBeenCalledWith("test-session"));
    await setPromptText(ref, "Please inspect this UI.");

    await act(async () => {
      firePending?.({ sessionId: "test-session" });
      await Promise.resolve();
    });

    expect(await screen.findByText("review-frame-1-display-1.png")).toBeInTheDocument();
    expect(screen.getByText("review-frame-1-display-1-marked.png")).toBeInTheDocument();
    expect(screen.getByText("review-frame-2-display-1.png")).toBeInTheDocument();
    expect(screen.getByText("review-frame-2-display-1-marked.png")).toBeInTheDocument();
    expect(screen.getByText("review-frame-2-voice-note-1-pin-2.webm")).toBeInTheDocument();
    await waitFor(() => expect(promptEditorText()).toContain("Move the CTA above the fold."));
    const text = promptEditorText();
    expect(text).toContain("Please inspect this UI.");
    expect(text).toContain("Screen review");
    expect(text).toContain("## Frame 1");
    expect(text).toContain("## Frame 2");
    expect(text).toContain("Keep the modal centered after resize.");
  });

  it("shows a toast when the overlay reports an async runtime error", () => {
    let fireError: ((event: { message: string }) => void) | undefined;
    const onError = vi.fn<OverlayReviewAPI["onError"]>((callback) => {
      fireError = callback;
      return () => {};
    });
    installMockAPIs({
      overlayReviewAPI: { onError },
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
    });

    render(<ChatInput {...defaultProps} />);
    act(() => {
      fireError?.({ message: "Screen review overlay failed." });
    });

    expect(toast.error).toHaveBeenCalledWith("Screen review overlay failed.");
  });
});

describe("ChatInput — prompt history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
    });
  });

  it("ArrowUp recalls the most recent user message", async () => {
    render(<ChatInput {...defaultProps} userMessages={["hello", "world"]} />);

    pressInPromptEditor("ArrowUp");
    await waitFor(() => {
      expect(promptEditorText()).toBe("world");
    });
  });

  it("ArrowUp recalls user messages without hidden context markers", async () => {
    render(
      <ChatInput
        {...defaultProps}
        userMessages={["please ask **Alice** <!--ctx:mailto:alice@example.com-->"]}
      />,
    );

    pressInPromptEditor("ArrowUp");

    await waitFor(() => {
      expect(promptEditorText()).toBe("please ask **Alice**");
    });
  });

  it("ArrowUp then ArrowDown restores the original draft", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} userMessages={["hello"]} />);

    await setPromptText(ref, "my draft");

    pressInPromptEditor("ArrowUp");
    await waitFor(() => expect(promptEditorText()).toBe("hello"));

    pressInPromptEditor("ArrowDown");
    await waitFor(() => expect(promptEditorText()).toBe("my draft"));
  });

  it.each([
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ] as const)("%s+ArrowUp does not recall prompt history", async (_label, modifier) => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} userMessages={["hello"]} />);

    await setPromptText(ref, "my draft");

    pressInPromptEditor("ArrowUp", modifier);
    await waitFor(() => expect(promptEditorText()).toBe("my draft"));
  });

  it.each([
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["Meta", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
  ] as const)(
    "%s+ArrowDown does not restore the saved draft during history navigation",
    async (_label, modifier) => {
      const ref = createRef<ChatInputRef>();
      render(<ChatInput {...defaultProps} ref={ref} userMessages={["hello"]} />);

      await setPromptText(ref, "my draft");

      pressInPromptEditor("ArrowUp");
      await waitFor(() => expect(promptEditorText()).toBe("hello"));

      pressInPromptEditor("ArrowDown", modifier);
      await waitFor(() => expect(promptEditorText()).toBe("hello"));
    },
  );

  it("Escape cancels history navigation and restores the draft", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} userMessages={["recalled"]} />);

    await setPromptText(ref, "draft text");

    pressInPromptEditor("ArrowUp");
    await waitFor(() => expect(promptEditorText()).toBe("recalled"));

    pressInPromptEditor("Escape");
    await waitFor(() => expect(promptEditorText()).toBe("draft text"));
  });

  it("switching sessionId clears history so ArrowUp no longer recalls old prompts", async () => {
    const { rerender } = render(
      <ChatInput {...defaultProps} sessionId="session-a" userMessages={["from session A"]} />,
    );

    pressInPromptEditor("ArrowUp");
    await waitFor(() => expect(promptEditorText()).toBe("from session A"));

    pressInPromptEditor("ArrowDown");

    rerender(<ChatInput {...defaultProps} sessionId="session-b" userMessages={[]} />);

    pressInPromptEditor("ArrowUp");
    await waitFor(() => expect(promptEditorText()).toBe(""));
  });
});

describe("ChatInput — chat context files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
    });
  });

  it("renders context file pills when files are added via ref", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    act(() => {
      ref.current!.addContextFile("/workspace/report.docx");
      ref.current!.addContextFile("/workspace/data.csv");
    });

    await waitFor(() => {
      expect(screen.getByText("report.docx")).toBeInTheDocument();
      expect(screen.getByText("data.csv")).toBeInTheDocument();
    });
  });

  it("does not render context file pills when no files added", () => {
    render(<ChatInput {...defaultProps} />);

    const pillContainers = screen.queryAllByTestId("pill-list-container");
    expect(pillContainers).toHaveLength(0);
  });

  it("removes a context file pill when the remove button is clicked", async () => {
    const user = userEvent.setup();
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    act(() => {
      ref.current!.addContextFile("/workspace/report.docx");
    });

    await waitFor(() => {
      expect(screen.getByText("report.docx")).toBeInTheDocument();
    });

    const removeBtn = screen.getByRole("button", { name: "Remove report.docx" });
    await user.click(removeBtn);

    expect(screen.queryByText("report.docx")).not.toBeInTheDocument();
  });
});

describe("ChatInput — cancellation state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
    });
  });

  it("blocks submit and preserves the draft while cancellation is active", async () => {
    const ref = createRef<ChatInputRef>();
    const onSubmit = vi.fn<(text: string) => void>();
    render(<ChatInput {...defaultProps} ref={ref} isCancelling onSubmit={onSubmit} />);

    await setPromptText(ref, "send this after cancellation");
    pressInPromptEditor("Enter");

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(promptEditorText()).toBe("send this after cancellation");
  });
});

describe("ChatInput — active turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
    });
  });

  it("steers on plain Enter instead of queueing", async () => {
    const ref = createRef<ChatInputRef>();
    const onSubmit = vi.fn<ChatInputProps["onSubmit"]>();
    const onSteer = vi.fn<NonNullable<ChatInputProps["onSteer"]>>();
    render(
      <ChatInput {...defaultProps} ref={ref} isWaiting onSubmit={onSubmit} onSteer={onSteer} />,
    );

    await setPromptText(ref, "adjust the current work");
    pressInPromptEditor("Enter");

    expect(onSteer).toHaveBeenCalledExactlyOnceWith("adjust the current work", [], {
      sessionId: "test-session",
      isWaiting: true,
      isCancelling: false,
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("ChatInput — mobile Enter behavior", () => {
  function installMatchMedia(matches: boolean) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => true,
      }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
    });
  });

  it("inserts a newline instead of submitting on plain Enter in mobile view", async () => {
    installMatchMedia(true);
    const ref = createRef<ChatInputRef>();
    const onSubmit = vi.fn<ChatInputProps["onSubmit"]>();
    render(<ChatInput {...defaultProps} ref={ref} onSubmit={onSubmit} />);

    await setPromptText(ref, "first line");
    pressInPromptEditor("Enter");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(promptEditorText()).toContain("first line");
  });

  it("still submits on Ctrl/Cmd+Enter in mobile view", async () => {
    installMatchMedia(true);
    const ref = createRef<ChatInputRef>();
    const onSubmit = vi.fn<ChatInputProps["onSubmit"]>();
    render(<ChatInput {...defaultProps} ref={ref} onSubmit={onSubmit} />);

    await setPromptText(ref, "submit via modifier");
    pressInPromptEditor("Enter", { ctrlKey: true });

    expect(onSubmit).toHaveBeenCalledWith("submit via modifier", [], {
      sessionId: "test-session",
      isWaiting: false,
      isCancelling: false,
    });
  });

  it("still submits on plain Enter outside mobile view", async () => {
    installMatchMedia(false);
    const ref = createRef<ChatInputRef>();
    const onSubmit = vi.fn<ChatInputProps["onSubmit"]>();
    render(<ChatInput {...defaultProps} ref={ref} onSubmit={onSubmit} />);

    await setPromptText(ref, "desktop submit");
    pressInPromptEditor("Enter");

    expect(onSubmit).toHaveBeenCalledWith("desktop submit", [], {
      sessionId: "test-session",
      isWaiting: false,
      isCancelling: false,
    });
  });
});

describe("ChatInput — non-image file upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
    });
    // Electron sandbox mode leaves File.path empty, so tests must go through getPathForFile.
    vi.mocked(window.workspaceAPI.getPathForFile).mockReturnValue("/tmp/docs/report.pdf");
  });

  it("resolves attachment path via workspaceAPI.getPathForFile and submits it", async () => {
    const onSubmit = vi.fn<(text: string, files: Array<{ path?: string; name: string }>) => void>();
    const user = userEvent.setup();
    const ref = createRef<ChatInputRef>();

    render(<ChatInput {...defaultProps} ref={ref} onSubmit={onSubmit} />);

    const fileInput = screen.getByTestId<HTMLInputElement>("chat-file-input");

    const file = new File(["hello"], "report.pdf", { type: "application/pdf" });
    await user.upload(fileInput, file);

    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });

    await setPromptText(ref, "what's in this?");
    pressInPromptEditor("Enter");

    expect(window.workspaceAPI.getPathForFile).toHaveBeenCalledWith(file);
    expect(onSubmit).toHaveBeenCalledWith(
      "what's in this?",
      [{ path: "/tmp/docs/report.pdf", name: "report.pdf", mimeType: "application/pdf" }],
      { sessionId: "test-session", isWaiting: false, isCancelling: false },
    );
  });
});

describe("ChatInput — drag-and-drop file attachment", () => {
  let mainEl: HTMLElement | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
    });
    vi.mocked(window.workspaceAPI.getPathForFile).mockReturnValue("/tmp/docs/dropped.pdf");
    // Production renders the drop overlay into <main> via a portal. happy-dom
    // has no <main> by default, so add one to exercise the real portal path.
    mainEl = document.createElement("main");
    document.body.appendChild(mainEl);
  });

  afterEach(() => {
    mainEl?.remove();
    mainEl = null;
  });

  function fireDrop(form: HTMLElement, files: File[]) {
    // In production, drops are caught by the full-screen overlay (rendered into
    // <main> via a portal while a file is being dragged). Mirror that flow:
    // dragenter to render the overlay, then dispatch the drop on the overlay.
    fireDragEnter(form, ["Files"]);
    const overlay = screen.getByTestId("chat-input-drop-overlay");
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: {
        files,
        types: ["Files"],
        dropEffect: "none",
      },
    });
    act(() => {
      overlay.dispatchEvent(dropEvent);
    });
    return dropEvent;
  }

  function fireDragOver(form: HTMLElement, types: string[]) {
    const dragOverEvent = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(dragOverEvent, "dataTransfer", {
      value: { types, dropEffect: "none" },
    });
    act(() => {
      form.dispatchEvent(dragOverEvent);
    });
    return dragOverEvent;
  }

  function fireDragEnter(form: HTMLElement, types: string[]) {
    const e = new Event("dragenter", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types } });
    act(() => {
      form.dispatchEvent(e);
    });
    return e;
  }

  function fireDragLeave(form: HTMLElement, types: string[]) {
    const e = new Event("dragleave", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types } });
    act(() => {
      form.dispatchEvent(e);
    });
    return e;
  }

  it("attaches a non-image file dropped onto the compose box", async () => {
    const onSubmit = vi.fn<(text: string, files: Array<{ path?: string; name: string }>) => void>();
    render(<ChatInput {...defaultProps} onSubmit={onSubmit} />);

    const form = screen.getByTestId("chat-input");
    const file = new File(["hello"], "dropped.pdf", { type: "application/pdf" });
    fireDrop(form, [file]);

    await waitFor(() => {
      expect(screen.getByText("dropped.pdf")).toBeInTheDocument();
    });
    expect(window.workspaceAPI.getPathForFile).toHaveBeenCalledWith(file);
  });

  it("attaches an image file dropped onto the compose box (data URL via FileReader)", async () => {
    render(<ChatInput {...defaultProps} />);

    const form = screen.getByTestId("chat-input");
    const file = new File(["fakebytes"], "photo.png", { type: "image/png" });
    fireDrop(form, [file]);

    await waitFor(() => {
      expect(screen.getByText("photo.png")).toBeInTheDocument();
    });
    // Image path goes through FileReader, not workspaceAPI.getPathForFile.
    expect(window.workspaceAPI.getPathForFile).not.toHaveBeenCalled();
  });

  it("attaches multiple files dropped at once", async () => {
    render(<ChatInput {...defaultProps} />);

    const form = screen.getByTestId("chat-input");
    const a = new File(["a"], "a.txt", { type: "text/plain" });
    const b = new File(["b"], "b.txt", { type: "text/plain" });
    fireDrop(form, [a, b]);

    await waitFor(() => {
      expect(screen.getByText("a.txt")).toBeInTheDocument();
      expect(screen.getByText("b.txt")).toBeInTheDocument();
    });
  });

  it("ignores drops with an empty FileList", () => {
    render(<ChatInput {...defaultProps} />);
    const form = screen.getByTestId("chat-input");
    const dropEvent = fireDrop(form, []);
    // No pills rendered, default not prevented (handler bails before preventDefault).
    expect(screen.queryByTestId("attachment-pill")).not.toBeInTheDocument();
    expect(dropEvent.defaultPrevented).toBe(false);
  });

  it("calls preventDefault on dragover when files are being dragged so drop fires", () => {
    render(<ChatInput {...defaultProps} />);
    const form = screen.getByTestId("chat-input");
    const e = fireDragOver(form, ["Files"]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("does not preventDefault on dragover for non-file drags (e.g. text)", () => {
    render(<ChatInput {...defaultProps} />);
    const form = screen.getByTestId("chat-input");
    const e = fireDragOver(form, ["text/plain"]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("calls preventDefault on drop when files are present (prevents Electron navigation)", () => {
    render(<ChatInput {...defaultProps} />);
    const form = screen.getByTestId("chat-input");
    const file = new File(["x"], "x.pdf", { type: "application/pdf" });
    const e = fireDrop(form, [file]);
    expect(e.defaultPrevented).toBe(true);
  });

  it("appends to existing attachments instead of replacing on a second drop", async () => {
    const user = userEvent.setup();
    render(<ChatInput {...defaultProps} />);
    const form = screen.getByTestId("chat-input");
    const fileInput = screen.getByTestId<HTMLInputElement>("chat-file-input");

    const first = new File(["a"], "first.pdf", { type: "application/pdf" });
    await user.upload(fileInput, first);
    await screen.findByText("first.pdf");

    const second = new File(["b"], "second.pdf", { type: "application/pdf" });
    fireDrop(form, [second]);

    await waitFor(() => {
      expect(screen.getByText("first.pdf")).toBeInTheDocument();
      expect(screen.getByText("second.pdf")).toBeInTheDocument();
    });
  });

  it("handles a mixed drop (image + non-image) routing each through the correct path", async () => {
    render(<ChatInput {...defaultProps} />);
    const form = screen.getByTestId("chat-input");
    const img = new File(["bytes"], "shot.png", { type: "image/png" });
    const doc = new File(["bytes"], "spec.pdf", { type: "application/pdf" });
    fireDrop(form, [img, doc]);

    await waitFor(() => {
      expect(screen.getByText("shot.png")).toBeInTheDocument();
      expect(screen.getByText("spec.pdf")).toBeInTheDocument();
    });
    expect(window.workspaceAPI.getPathForFile).toHaveBeenCalledTimes(1);
    expect(window.workspaceAPI.getPathForFile).toHaveBeenCalledWith(doc);
  });

  it("still attaches a non-image when getPathForFile returns an empty string", async () => {
    vi.mocked(window.workspaceAPI.getPathForFile).mockReturnValue("");
    render(<ChatInput {...defaultProps} />);
    const form = screen.getByTestId("chat-input");
    const file = new File(["x"], "no-path.bin", { type: "application/octet-stream" });
    fireDrop(form, [file]);

    await waitFor(() => {
      expect(screen.getByText("no-path.bin")).toBeInTheDocument();
    });
  });

  it("attaches a file with no MIME type (treats it as a generic file, not an image)", async () => {
    render(<ChatInput {...defaultProps} />);
    const form = screen.getByTestId("chat-input");
    const file = new File(["x"], "unknown", { type: "" });
    fireDrop(form, [file]);

    await waitFor(() => {
      expect(screen.getByText("unknown")).toBeInTheDocument();
    });
    // Empty type → non-image branch → getPathForFile is called.
    expect(window.workspaceAPI.getPathForFile).toHaveBeenCalledWith(file);
  });

  it("shows drop overlay on dragenter and clears it on dragleave", () => {
    render(<ChatInput {...defaultProps} />);
    const form = screen.getByTestId("chat-input");
    expect(screen.queryByTestId("chat-input-drop-overlay")).not.toBeInTheDocument();

    fireDragEnter(form, ["Files"]);
    expect(screen.getByTestId("chat-input-drop-overlay")).toBeInTheDocument();

    fireDragLeave(form, ["Files"]);
    expect(screen.queryByTestId("chat-input-drop-overlay")).not.toBeInTheDocument();
  });

  it("clears drop overlay after a successful drop", async () => {
    render(<ChatInput {...defaultProps} />);
    const form = screen.getByTestId("chat-input");

    const file = new File(["x"], "x.pdf", { type: "application/pdf" });
    // fireDrop already dispatches dragenter to render the overlay.
    fireDrop(form, [file]);

    await waitFor(() => {
      expect(screen.queryByTestId("chat-input-drop-overlay")).not.toBeInTheDocument();
    });
  });

  it("does not show overlay for non-file drags (e.g. text)", () => {
    render(<ChatInput {...defaultProps} />);
    const form = screen.getByTestId("chat-input");
    fireDragEnter(form, ["text/plain"]);
    expect(screen.queryByTestId("chat-input-drop-overlay")).not.toBeInTheDocument();
  });
});

describe("ChatInput — draft preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
    });
  });

  it("preserves draft text when switching sessions and restores it on return", async () => {
    const ref = createRef<ChatInputRef>();
    const { rerender } = render(<ChatInput {...defaultProps} ref={ref} sessionId="session-a" />);

    await setPromptText(ref, "my draft for A");
    expect(promptEditorText()).toBe("my draft for A");

    rerender(<ChatInput {...defaultProps} ref={ref} sessionId="session-b" />);
    await waitFor(() => expect(promptEditorText()).toBe(""));

    await setPromptText(ref, "draft for B");

    rerender(<ChatInput {...defaultProps} ref={ref} sessionId="session-a" />);
    await waitFor(() => expect(promptEditorText()).toBe("my draft for A"));

    rerender(<ChatInput {...defaultProps} ref={ref} sessionId="session-b" />);
    await waitFor(() => expect(promptEditorText()).toBe("draft for B"));
  });

  it("clears saved draft when message is sent", async () => {
    const onSubmit = vi.fn<(text: string) => void>();
    const ref = createRef<ChatInputRef>();
    const { rerender } = render(
      <ChatInput {...defaultProps} ref={ref} sessionId="session-a" onSubmit={onSubmit} />,
    );

    await setPromptText(ref, "will be sent");
    rerender(<ChatInput {...defaultProps} ref={ref} sessionId="session-b" onSubmit={onSubmit} />);

    rerender(<ChatInput {...defaultProps} ref={ref} sessionId="session-a" onSubmit={onSubmit} />);
    await waitFor(() => expect(promptEditorText()).toBe("will be sent"));

    pressInPromptEditor("Enter");
    expect(onSubmit).toHaveBeenCalledWith("will be sent", expect.any(Array), {
      sessionId: "session-a",
      isWaiting: false,
      isCancelling: false,
    });

    rerender(<ChatInput {...defaultProps} ref={ref} sessionId="session-b" onSubmit={onSubmit} />);
    rerender(<ChatInput {...defaultProps} ref={ref} sessionId="session-a" onSubmit={onSubmit} />);
    await waitFor(() => expect(promptEditorText()).toBe(""));
  });

  it("does not save a draft when input is empty on switch", async () => {
    const ref = createRef<ChatInputRef>();
    const { rerender } = render(<ChatInput {...defaultProps} ref={ref} sessionId="session-a" />);

    await setPromptText(ref, "some text");
    await clearPromptText(ref);
    expect(promptEditorText()).toBe("");

    rerender(<ChatInput {...defaultProps} ref={ref} sessionId="session-b" />);

    rerender(<ChatInput {...defaultProps} ref={ref} sessionId="session-a" />);
    expect(promptEditorText()).toBe("");
  });

  it("clearDraft via ref removes a saved draft for a specific session", async () => {
    const ref = createRef<ChatInputRef>();
    const { rerender } = render(<ChatInput {...defaultProps} sessionId="session-a" ref={ref} />);

    await setPromptText(ref, "will be deleted");
    rerender(<ChatInput {...defaultProps} sessionId="session-b" ref={ref} />);

    act(() => ref.current!.clearDraft("session-a"));

    rerender(<ChatInput {...defaultProps} sessionId="session-a" ref={ref} />);
    await waitFor(() => expect(promptEditorText()).toBe(""));
  });

  it("clearDraft via ref with no argument clears all drafts", async () => {
    const ref = createRef<ChatInputRef>();
    const { rerender } = render(<ChatInput {...defaultProps} sessionId="session-a" ref={ref} />);

    await setPromptText(ref, "draft A");
    rerender(<ChatInput {...defaultProps} sessionId="session-b" ref={ref} />);
    await setPromptText(ref, "draft B");
    rerender(<ChatInput {...defaultProps} sessionId="session-c" ref={ref} />);

    act(() => ref.current!.clearDraft());

    rerender(<ChatInput {...defaultProps} sessionId="session-a" ref={ref} />);
    await waitFor(() => expect(promptEditorText()).toBe(""));
    rerender(<ChatInput {...defaultProps} sessionId="session-b" ref={ref} />);
    await waitFor(() => expect(promptEditorText()).toBe(""));
  });

  it("migrateDraftToSession hands the current input to a new session on swap", async () => {
    // Scenario: user types a prompt into session A, then a soul change
    // replaces A with B. migrateDraftToSession should seed B's draft with
    // what's in the editor so the swap doesn't visually drop the input.
    const ref = createRef<ChatInputRef>();
    const { rerender } = render(<ChatInput {...defaultProps} sessionId="session-a" ref={ref} />);

    await setPromptText(ref, "typed for A");

    // Simulate the useSessionManager.handleSoulChange flow:
    // 1) migrate the draft onto the new session id, 2) re-render with that id.
    act(() => ref.current!.migrateDraftToSession("session-a", "session-b"));
    rerender(<ChatInput {...defaultProps} sessionId="session-b" ref={ref} />);

    await waitFor(() => expect(promptEditorText()).toBe("typed for A"));
  });

  it("migrateDraftToSession cleans up the old session's draft (no orphan)", async () => {
    // Returning to the originally-typed session after migration should find
    // nothing — A's draft was moved to B, not duplicated to both. The
    // suppress-next-switch-save flag must also prevent the session-switch
    // effect from re-saving A's draft via saveDraft(prevId, ...).
    const ref = createRef<ChatInputRef>();
    const { rerender } = render(<ChatInput {...defaultProps} sessionId="session-a" ref={ref} />);

    await setPromptText(ref, "typed for A");

    act(() => ref.current!.migrateDraftToSession("session-a", "session-b"));
    rerender(<ChatInput {...defaultProps} sessionId="session-b" ref={ref} />);
    await waitFor(() => expect(promptEditorText()).toBe("typed for A"));

    rerender(<ChatInput {...defaultProps} sessionId="session-a" ref={ref} />);
    await waitFor(() => expect(promptEditorText()).toBe(""));
  });

  it("migrateDraftToSession can preserve the source chat's draft", async () => {
    const ref = createRef<ChatInputRef>();
    const { rerender } = render(<ChatInput {...defaultProps} sessionId="session-a" ref={ref} />);

    await setPromptText(ref, "keep this prompt");

    act(() =>
      ref.current!.migrateDraftToSession("session-a", "session-b", undefined, {
        preserveSource: true,
      }),
    );
    rerender(<ChatInput {...defaultProps} sessionId="session-b" ref={ref} />);
    await waitFor(() => expect(promptEditorText()).toBe("keep this prompt"));

    rerender(<ChatInput {...defaultProps} sessionId="session-a" ref={ref} />);
    await waitFor(() => expect(promptEditorText()).toBe("keep this prompt"));
  });

  it("hasInput via ref returns false when editor is empty", () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);
    expect(ref.current!.hasInput()).toBe(false);
  });

  it("hasInput via ref returns true when editor has text", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await setPromptText(ref, "hello");
    expect(ref.current!.hasInput()).toBe(true);
  });

  it("hasInput via ref returns false for whitespace-only input", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await setPromptText(ref, "   ");
    expect(ref.current!.hasInput()).toBe(false);
  });

  it("startTyping drips the full text into the editor across multiple frames", async () => {
    // Regression guard: Lexical's OnChange listeners fire for programmatic
    // editor writes too. ChangeRelayPlugin filters out updates tagged
    // PROGRAMMATIC_UPDATE_TAG so handleEditorChange (and its
    // cancelTypewriter call) never sees the typewriter's own writes.
    // Without that filter, the drip would self-cancel after its first
    // tick and only the first character (or none) would land. This test
    // forces the rAF loop to cross multiple frames so a naive
    // "always cancel on editor change" wiring would commit at most one
    // intermediate slice and never reach the full string.
    const pendingFrames: Array<{ id: number; cb: FrameRequestCallback } | null> = [];
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      const id = pendingFrames.length + 1;
      pendingFrames.push({ id, cb });
      return id;
    });
    const cafSpy = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      const idx = pendingFrames.findIndex((f) => f !== null && f.id === id);
      if (idx >= 0) pendingFrames[idx] = null;
    });

    try {
      const ref = createRef<ChatInputRef>();
      render(<ChatInput {...defaultProps} ref={ref} />);

      act(() => ref.current!.startTyping("hello world"));

      const drainFrame = (now: number) => {
        while (pendingFrames.length > 0 && pendingFrames[0] === null) pendingFrames.shift();
        const frame = pendingFrames.shift();
        if (!frame) return;
        act(() => frame.cb(now));
      };

      // Crank rAF until the typewriter signals completion (no more frames).
      let safety = 200;
      let now = 0;
      while (pendingFrames.length > 0 && safety-- > 0) {
        now += 16;
        drainFrame(now);
      }

      await waitFor(() => expect(promptEditorText()).toBe("hello world"));
    } finally {
      rafSpy.mockRestore();
      cafSpy.mockRestore();
    }
  });
});

describe("ChatInput — slash menu dismiss semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: sampleSkills }),
        onChanged: vi.fn<SkillsAPI["onChanged"]>().mockReturnValue(() => {}),
      },
    });
  });

  it("Escape hides the menu for the current input, typing re-opens it", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "/sum");
    expect(screen.getByText("Summarize text")).toBeInTheDocument();

    pressInPromptEditor("Escape");
    expect(screen.queryByText("Summarize text")).not.toBeInTheDocument();

    await setPromptText(ref, "/summ");
    expect(screen.getByText("Summarize text")).toBeInTheDocument();
  });

  it("resets selectedSkillIndex to 0 when the menu re-opens via non-typing input (imperative setInput)", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "/");
    pressInPromptEditor("ArrowDown");

    act(() => ref.current!.setInput("hello"));
    await waitFor(() => expect(screen.queryByText("Summarize text")).not.toBeInTheDocument());
    act(() => ref.current!.setInput("/"));

    await screen.findByText("Summarize text");
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");
  });

  it("Escape strips the trigger from the input (picker-dismiss behavior)", async () => {
    const ref = createRef<ChatInputRef>();
    const { rerender } = render(<ChatInput {...defaultProps} ref={ref} sessionId="session-a" />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "/sum");
    await screen.findByText("Summarize text");
    pressInPromptEditor("Escape");
    await waitFor(() => expect(screen.queryByText("Summarize text")).not.toBeInTheDocument());

    // Picker's onClose strips the trigger slash + query from the editor
    // (intentional UX from the Context Picker spec). The persisted draft
    // therefore reflects the post-strip state, not "/sum".
    expect(promptEditorText()).toBe("");

    rerender(<ChatInput {...defaultProps} ref={ref} sessionId="session-b" />);
    rerender(<ChatInput {...defaultProps} ref={ref} sessionId="session-a" />);

    expect(promptEditorText()).toBe("");
  });

  it("imperative setInput re-opens the slash menu when the new value matches the trigger", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "/sum");
    pressInPromptEditor("Escape");
    await waitFor(() => expect(screen.queryByText("Summarize text")).not.toBeInTheDocument());

    // Round-trip through a non-matching value so the editor sees an actual change
    // (the typeahead plugin only re-evaluates triggerFn on editor updates).
    act(() => ref.current!.setInput(""));
    act(() => ref.current!.setInput("/sum"));
    await screen.findByText("Summarize text");
  });

  it("typing back to the dismissed input reopens the menu", async () => {
    render(<ChatInput {...defaultProps} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptTextDOM("/sum");
    await screen.findByText("Summarize text");

    pressInPromptEditor("Escape");
    await waitFor(() => expect(screen.queryByText("Summarize text")).not.toBeInTheDocument());

    await setPromptTextDOM("/summ");
    await screen.findByText("Summarize text");

    await setPromptTextDOM("/sum");
    await screen.findByText("Summarize text");
  });
});

describe("ChatInput — imageSizeWarning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
        onChanged: vi.fn<SkillsAPI["onChanged"]>().mockReturnValue(() => {}),
      },
    });
  });

  it("shows a dismissible warning banner when a pending file is flagged as large", async () => {
    const user = userEvent.setup();
    render(<ChatInput {...defaultProps} />);

    const editor = getPromptEditor();
    const oversized = new File([new Uint8Array(6 * 1024 * 1024)], "big.png", {
      type: "image/png",
    });

    // happy-dom does not populate clipboardData on real paste events.
    editor.focus();
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [
          {
            type: "image/png",
            getAsFile: () => oversized,
          },
        ],
      },
    });
    act(() => {
      editor.dispatchEvent(pasteEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(/is large and may slow down the chat/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Dismiss attachment warning" }));
    expect(screen.queryByText(/is large and may slow down the chat/)).not.toBeInTheDocument();
  });

  it("dismisses an initialization error without enabling the editor", async () => {
    const user = userEvent.setup();
    render(
      <ChatInput {...defaultProps} sdkReady={false} initError="Copilot failed to initialize" />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Copilot failed to initialize");
    expect(getPromptEditor()).toHaveAttribute("aria-disabled", "true");

    await user.click(screen.getByRole("button", { name: "Dismiss chat error" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getPromptEditor()).toHaveAttribute("aria-disabled", "true");
  });
});

describe("ChatInput — picker ARIA attributes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: sampleSkills }),
        onChanged: vi.fn<SkillsAPI["onChanged"]>().mockReturnValue(() => {}),
      },
    });
  });

  it("wires picker aria attributes onto the editor textbox when active", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    const textbox = screen.getByRole("textbox", { name: /message/i });

    // Before activation: haspopup is set, expanded is false, controls is absent.
    expect(textbox).toHaveAttribute("aria-haspopup", "listbox");
    expect(textbox).toHaveAttribute("aria-expanded", "false");
    expect(textbox).not.toHaveAttribute("aria-controls");

    // Trigger the picker by typing "/" at the start of the input
    // (`/` is the picker trigger; start-slash opens Skills tab).
    await setPromptText(ref, "/");

    await waitFor(() => {
      expect(textbox).toHaveAttribute("aria-expanded", "true");
    });
    await waitFor(() => {
      const listbox = screen.getByRole("listbox");
      expect(listbox).toHaveAttribute("id", "context-picker-listbox");
      expect(textbox.getAttribute("aria-controls")).toBe(listbox.id);
    });
  });
});

describe("ChatInput — picker suppresses prompt history navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: sampleSkills }),
        onChanged: vi.fn<SkillsAPI["onChanged"]>().mockReturnValue(() => {}),
      },
    });
  });

  it("does not navigate prompt history when the picker is open", async () => {
    // Seed prompt history so ArrowUp would normally recall "earlier prompt".
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} userMessages={["earlier prompt"]} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    // Open the picker via "/" trigger (start-slash opens Skills tab).
    await setPromptText(ref, "/");
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /message/i })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    // Verify at least 2 skill options are rendered so we can observe selection change.
    const optionsBefore = await screen.findAllByRole("option");
    expect(optionsBefore.length).toBeGreaterThanOrEqual(2);

    // First option should be selected by default (index 0).
    expect(optionsBefore[0]).toHaveAttribute("aria-selected", "true");
    expect(optionsBefore[1]).toHaveAttribute("aria-selected", "false");

    // ArrowDown while picker is open should move selection to index 1 (second option).
    pressInPromptEditor("ArrowDown");

    // Verify selection moved: second option now selected, first no longer selected.
    const optionsAfter = screen.getAllByRole("option");
    expect(optionsAfter[1]).toHaveAttribute("aria-selected", "true");
    expect(optionsAfter[0]).toHaveAttribute("aria-selected", "false");

    // Also verify that ArrowUp still does NOT recall prompt history.
    pressInPromptEditor("ArrowUp");
    expect(promptEditorText()).not.toBe("earlier prompt");
  });

  it("does not navigate prompt history when the picker is open and has no results yet", async () => {
    // Empty-results case: picker active but no skill matches the query.
    // Arrow keys must still be suppressed — open picker = user wants picker.
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} userMessages={["earlier prompt"]} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    // Type a query that matches no skills so pickerItemCount === 0.
    await setPromptText(ref, "/zzznomatch");
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /message/i })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    // ArrowUp must still be suppressed even with zero results.
    pressInPromptEditor("ArrowUp");

    expect(promptEditorText()).not.toBe("earlier prompt");
  });
});

describe("ChatInput — picker skill selection inserts a bold pill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: sampleSkills }),
        onChanged: vi.fn<SkillsAPI["onChanged"]>().mockReturnValue(() => {}),
      },
    });
  });

  it("selecting a skill from the picker via Enter inserts a SkillPillNode (not plain text)", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    // Open the picker, narrow to "summarize", and press Enter to select it.
    await setPromptText(ref, "/sum");
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /message/i })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });
    await screen.findByText("Summarize text");

    pressInPromptEditor("Enter");

    // The picker must insert a SkillPillNode — rendered as a span with
    // data-testid="skill-pill" and `font-semibold` (via InlinePillDecorator).
    // Plain-text-only insertion (the regression we are guarding against)
    // would leave NO such node in the editor, only literal "/summarize "
    // text content.
    const pill = await screen.findByTestId("skill-pill");
    expect(pill).toHaveTextContent("/summarize");

    // The plain-text round-trip should also be the canonical "/skillname "
    // form (matches the slash-typeahead path's contract — see
    // SkillTypeahead.marshal.integration.test.tsx).
    expect(promptEditorText()).toBe("/summarize ");
  });

  it("selecting a person from the picker inserts a ContextChipNode", async () => {
    const user = userEvent.setup();
    const ref = createRef<ChatInputRef>();
    const alice = {
      type: "People" as const,
      id: "p1",
      referenceId: "p1",
      displayName: "Alice Person",
      email: "alice@example.com",
    };
    vi.mocked(window.contextPickerAPI!.search).mockImplementation(async (query) => ({
      success: true,
      entities: query === "ali" ? [alice] : [],
    }));

    render(<ChatInput {...defaultProps} ref={ref} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "ask @ali");
    await user.click(await screen.findByRole("tab", { name: /people/i }));

    const aliceOption = await screen.findByRole("option", { name: /Alice Person/ });
    expect(aliceOption).toHaveAttribute("aria-selected", "true");
    // happy-dom can reject Lexical's transient focus restore after decorator insertion.
    const originalSetBaseAndExtent = Selection.prototype.setBaseAndExtent;
    const setBaseAndExtent = vi
      .spyOn(Selection.prototype, "setBaseAndExtent")
      .mockImplementation(function (
        this: Selection,
        ...args: Parameters<Selection["setBaseAndExtent"]>
      ) {
        try {
          return originalSetBaseAndExtent.apply(this, args);
        } catch (error) {
          if (
            error instanceof DOMException &&
            error.name === "IndexSizeError" &&
            error.message === "Invalid anchor or focus offset."
          ) {
            return;
          }
          throw error;
        }
      });
    try {
      await user.click(aliceOption);

      const chip = await screen.findByTestId("chip-decorator");
      expect(chip).toHaveTextContent("Alice Person");

      await waitFor(() => {
        expect(promptEditorText()).not.toContain("@ali");
      });
      const text = promptEditorText();
      expect(text).toContain("ask ");
      expect(text).toContain("Alice Person");
      expect(window.contextPickerAPI?.search).toHaveBeenCalledWith("ali", ["People"]);
    } finally {
      setBaseAndExtent.mockRestore();
    }
  });
});

describe("ChatInput — picker aria-activedescendant tracks highlighted option", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: sampleSkills }),
        onChanged: vi.fn<SkillsAPI["onChanged"]>().mockReturnValue(() => {}),
      },
    });
  });

  it("aria-activedescendant on the textbox updates as ArrowDown moves selection", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "/");
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /message/i })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    const textbox = screen.getByRole("textbox", { name: /message/i });
    const optionsBefore = await screen.findAllByRole("option");
    expect(optionsBefore.length).toBeGreaterThanOrEqual(2);

    // First Skills row after typing `/` should be deterministic (skill id "s1").
    await waitFor(() => {
      expect(textbox).toHaveAttribute("aria-activedescendant", "context-picker-option-s1");
    });

    // DOM consistency assertion
    const activeId = textbox.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    // eslint-disable-next-line testing-library/no-node-access -- ARIA id must reference a real DOM element
    expect(document.getElementById(activeId!)).toHaveAttribute("role", "option");

    pressInPromptEditor("ArrowDown");

    // After ArrowDown to the second skill (skill id "s2").
    await waitFor(() => {
      expect(textbox).toHaveAttribute("aria-activedescendant", "context-picker-option-s2");
    });
  });

  it("omits aria-activedescendant when the picker is closed", async () => {
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    const textbox = screen.getByRole("textbox", { name: /message/i });
    expect(textbox).not.toHaveAttribute("aria-activedescendant");
  });

  it("replaces aria-activedescendant when the selected value is no longer rendered", async () => {
    // Open picker, type a query yielding multiple skills, navigate down so
    // selectedIndex points at a high index, then narrow the query so the
    // result list shrinks. The textbox's aria-activedescendant must move
    // to a deterministic live option id instead of keeping a removed id.
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);
    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    await setPromptText(ref, "/");
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /message/i })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    const textbox = screen.getByRole("textbox", { name: /message/i });
    const optionsBefore = await screen.findAllByRole("option");
    expect(optionsBefore.length).toBeGreaterThanOrEqual(2);

    // Move selection to the LAST option so a shrinking list immediately
    // strands selectedIndex past the new bounds.
    const lastIndex = optionsBefore.length - 1;
    for (let i = 0; i < lastIndex; i += 1) {
      pressInPromptEditor("ArrowDown");
    }

    // Sanity: aria-activedescendant references the last option deterministically.
    // The last option's id is read from the DOM (rather than hardcoded) so the
    // assertion stays correct regardless of what trails the skill list — e.g.
    // the built-in `/goal` command row that renders after skills on `/`.
    const lastOptionId = optionsBefore[lastIndex].id;
    await waitFor(() => {
      expect(textbox).toHaveAttribute("aria-activedescendant", lastOptionId);
    });

    // Narrow the query so only the first skill (summarize) survives the filter.
    await setPromptText(ref, "/summa");

    await waitFor(() => {
      const optionsAfter = screen.getAllByRole("option");
      expect(optionsAfter.length).toBeLessThan(optionsBefore.length);
    });

    // The textbox's aria-activedescendant should point to the first surviving
    // skill (s1/summarize) after the selected option is removed from the DOM.
    await waitFor(() => {
      expect(textbox).toHaveAttribute("aria-activedescendant", "context-picker-option-s1");
    });
    const correctedId = textbox.getAttribute("aria-activedescendant");
    expect(correctedId).toBeTruthy();
    // eslint-disable-next-line testing-library/no-node-access -- ARIA id must reference a real DOM element
    expect(document.getElementById(correctedId!)).toHaveAttribute("role", "option");
  });
});

describe("ChatInput — /goal commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
  });

  const fence = { goalId: "g1", epoch: 2 } as const;

  function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
    return {
      schemaVersion: 3,
      id: "g1",
      epoch: 2,
      objective: "old goal",
      criteria: [],
      status: "pursuing",
      createdAt: "2026-08-20T12:00:00.000Z",
      updatedAt: "2026-08-20T12:01:00.000Z",
      progress: [],
      openQuestions: [],
      assumptions: [],
      decisions: [],
      state: {},
      continuationCount: 0,
      activeMs: 0,
      tokensUsed: 0,
      ...overrides,
    };
  }

  function makeSnapshot(goalOverrides: Partial<GoalRecord> = {}): GoalRuntimeSnapshot {
    return {
      sessionId: "test-session",
      goal: makeGoal(goalOverrides),
      fence,
    };
  }

  it("keeps bare /goal in the composer so the user can enter a new objective", async () => {
    const goalGet = vi.fn<GoalAPI["get"]>();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
      goalAPI: { get: goalGet },
    });
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);
    await waitFor(() => expect(goalGet).toHaveBeenCalledWith("test-session"));
    goalGet.mockClear();

    await setPromptText(ref, "/goal");
    pressInPromptEditor("Enter");

    await waitFor(() => expect(getPromptEditor()).toHaveTextContent("/goal"));
    expect(goalGet).not.toHaveBeenCalled();
  });

  it("sets a goal directly when no goal exists", async () => {
    const created = makeSnapshot({ objective: "build the thing" });
    const set = vi.fn<GoalAPI["set"]>().mockResolvedValue({ success: true, snapshot: created });
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
      goalAPI: {
        get: vi.fn<GoalAPI["get"]>().mockResolvedValue({ success: true, snapshot: null }),
        set,
      },
    });
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await setPromptText(ref, "/goal build the thing");
    pressInPromptEditor("Enter");

    await waitFor(() =>
      expect(set).toHaveBeenCalledWith("test-session", {
        objective: "build the thing",
      }),
    );
  });

  it("starts a fresh goal when an existing goal is present", async () => {
    const existing = makeSnapshot();
    const updated = makeSnapshot({ objective: "build the thing" });
    const set = vi.fn<GoalAPI["set"]>().mockResolvedValue({ success: true, snapshot: updated });
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
      goalAPI: {
        get: vi.fn<GoalAPI["get"]>().mockResolvedValue({ success: true, snapshot: existing }),
        set,
      },
    });

    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await setPromptText(ref, "/goal build the thing");
    pressInPromptEditor("Enter");

    await waitFor(() =>
      expect(set).toHaveBeenCalledWith("test-session", {
        objective: "build the thing",
      }),
    );
    expect(screen.queryByTestId("confirm-replace-goal-dialog")).not.toBeInTheDocument();
  });

  it.each(["pause", "resume", "stop"] as const)("runs the %s control command", async (method) => {
    const action = vi.fn<GoalAPI[typeof method]>().mockResolvedValue({
      success: true,
      snapshot: makeSnapshot(),
    });
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
      goalAPI: {
        get: vi.fn<GoalAPI["get"]>().mockResolvedValue({ success: true, snapshot: makeSnapshot() }),
        [method]: action,
      },
    });
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await setPromptText(ref, `/goal ${method}`);
    pressInPromptEditor("Enter");

    await waitFor(() => expect(action).toHaveBeenCalledWith("test-session", fence));
  });

  it("steers the current goal through the command", async () => {
    const steer = vi.fn<GoalAPI["steer"]>().mockResolvedValue({
      success: true,
      snapshot: makeSnapshot(),
    });
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
      },
      goalAPI: {
        get: vi.fn<GoalAPI["get"]>().mockResolvedValue({ success: true, snapshot: makeSnapshot() }),
        steer,
      },
    });
    const ref = createRef<ChatInputRef>();
    render(<ChatInput {...defaultProps} ref={ref} />);

    await setPromptText(ref, "/goal steer focus on accessibility");
    pressInPromptEditor("Enter");

    await waitFor(() =>
      expect(steer).toHaveBeenCalledWith("test-session", {
        expectedFence: fence,
        instruction: "focus on accessibility",
      }),
    );
  });
});
