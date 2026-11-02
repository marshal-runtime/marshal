import userEvent from "@testing-library/user-event";
import { userEvent as browserUserEvent } from "@vitest/browser/context";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";
import type { ContextEntity, ContextPickerAPI, SkillsAPI, WorkspaceAPI } from "@/types/electron";

import { getPromptEditor, promptEditorText } from "../testing/prompt-editor-dom";
import { ChatInput, type ChatInputRef, _clearSessionDrafts } from "./ChatInput";

const defaultProps = {
  sessionId: "browser-test-session",
  userMessages: [] as string[],
  isWaiting: false,
  sdkReady: true,
  initError: null,
  hasUserMessages: false,
  onSubmit: vi.fn<(text: string) => void>(),
  onStop: vi.fn<() => void>(),
};

const alice: ContextEntity = {
  type: "People",
  id: "alice-id",
  referenceId: "alice-ref",
  displayName: "Alice Person",
  email: "alice@example.com",
};

type PickerFrame = {
  pickerLeft: number;
  pickerRight: number;
  pickerTop: number;
  pickerBottom: number;
  pickerWidth: number;
  anchorLeft: number;
  anchorRight: number;
  anchorTop: number;
  anchorWidth: number;
};

function readPickerFrame(picker: HTMLElement, editor: HTMLElement): PickerFrame {
  const pickerRect = picker.getBoundingClientRect();
  const anchorRect = editor.getBoundingClientRect();
  return {
    pickerLeft: pickerRect.left,
    pickerRight: pickerRect.right,
    pickerTop: pickerRect.top,
    pickerBottom: pickerRect.bottom,
    pickerWidth: pickerRect.width,
    anchorLeft: anchorRect.left,
    anchorRight: anchorRect.right,
    anchorTop: anchorRect.top,
    anchorWidth: anchorRect.width,
  };
}

function expectPickerFrameAligned(frame: PickerFrame) {
  expect(Math.abs(frame.pickerLeft - frame.anchorLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(frame.pickerRight - frame.anchorRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(frame.pickerWidth - frame.anchorWidth)).toBeLessThanOrEqual(1);
  expect(frame.pickerBottom).toBeLessThanOrEqual(frame.anchorTop);
}

function NarrowChatInput(
  props: React.ComponentProps<typeof ChatInput> & { width?: number },
): React.ReactElement {
  const { width = 220, ...rest } = props;
  return (
    <div data-testid="chat-input-container" style={{ width: `${width}px` }}>
      <ChatInput {...rest} />
    </div>
  );
}

function getEditor(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message" });
}

function editorText(): string {
  return getEditor().textContent ?? "";
}

async function waitForVisualLineCount(min: number): Promise<void> {
  await waitFor(() => {
    expect(currentVisualRowCount()).toBeGreaterThanOrEqual(min);
  });
}

function currentVisualRowCount(): number {
  const range = document.createRange();
  range.selectNodeContents(getEditor());
  const rowTops: number[] = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width === 0 && rect.height === 0) continue;
    if (!rowTops.some((top) => Math.abs(top - rect.top) <= 2)) {
      rowTops.push(rect.top);
    }
  }
  return rowTops.length;
}

describe("ChatInput visual-row ArrowUp/ArrowDown (browser)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
        onChanged: vi.fn<SkillsAPI["onChanged"]>().mockReturnValue(() => {}),
      },
    });
    _clearSessionDrafts();
  });

  it("ArrowUp recalls history when the caret is on the first visual row of a soft-wrapped draft", async () => {
    render(<NarrowChatInput {...defaultProps} userMessages={["recalled message"]} />);

    const editor = getEditor();
    await browserUserEvent.click(editor);
    const draft = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    await browserUserEvent.keyboard(draft);
    await waitForVisualLineCount(2);

    const rows = currentVisualRowCount();
    expect(rows).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < rows - 1; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential keystrokes move the real caret row-by-row.
      await browserUserEvent.keyboard("{ArrowUp}");
    }

    expect(editorText()).toBe(draft);

    await browserUserEvent.keyboard("{ArrowUp}");

    await waitFor(() => expect(editorText()).toBe("recalled message"));
  });

  it("ArrowUp leaves the draft unchanged when the caret is on a soft-wrapped non-first visual row", async () => {
    render(<NarrowChatInput {...defaultProps} userMessages={["recalled message"]} />);

    const editor = getEditor();
    await browserUserEvent.click(editor);
    const draft = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
    await browserUserEvent.keyboard(draft);
    await waitForVisualLineCount(2);

    await browserUserEvent.keyboard("{ArrowUp}");

    expect(editorText()).toBe(draft);
  });
});

describe("ChatInput context picker (browser)", () => {
  const previousGlobals: {
    skillsAPI?: typeof window.skillsAPI;
    contextPickerAPI?: typeof window.contextPickerAPI;
  } = {};

  beforeEach(() => {
    previousGlobals.skillsAPI = window.skillsAPI;
    previousGlobals.contextPickerAPI = window.contextPickerAPI;
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
        onChanged: vi.fn<SkillsAPI["onChanged"]>().mockReturnValue(() => {}),
      },
    });
    window.contextPickerAPI = {
      search: vi.fn<ContextPickerAPI["search"]>().mockImplementation(async (query) => ({
        success: true,
        entities: query === "ali" ? [alice] : [],
      })),
    };
  });

  afterEach(() => {
    _clearSessionDrafts();
    if (previousGlobals.skillsAPI) {
      window.skillsAPI = previousGlobals.skillsAPI;
    } else {
      delete (window as Partial<Pick<Window, "skillsAPI">>).skillsAPI;
    }
    if (previousGlobals.contextPickerAPI) {
      window.contextPickerAPI = previousGlobals.contextPickerAPI;
    } else {
      delete window.contextPickerAPI;
    }
  });

  it("inserts a visible ContextChipNode when Alice is selected from People results", async () => {
    const user = userEvent.setup();
    const ref = createRef<ChatInputRef>();

    render(<ChatInput {...defaultProps} ref={ref} />);

    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    const editor = getPromptEditor();
    await user.click(editor);
    await user.keyboard("ask @ali");
    await waitFor(() => {
      expect(promptEditorText()).toBe("ask @ali");
    });

    await user.click(await screen.findByRole("tab", { name: /people/i }));
    const aliceOption = await screen.findByRole("option", { name: /Alice Person/ });
    expect(aliceOption).toBeVisible();

    await user.click(aliceOption);

    const chip = await screen.findByTestId("chip-decorator");
    expect(chip).toBeVisible();
    expect(chip).toHaveTextContent("Alice Person");

    await waitFor(() => {
      const text = promptEditorText();
      expect(text).toContain("Alice Person");
      expect(text).not.toContain("@ali");
    });
    await user.keyboard("please");
    await waitFor(() => {
      expect(promptEditorText()).toBe("ask Alice Person please");
    });
    expect(window.contextPickerAPI?.search).toHaveBeenCalledWith("ali", ["People"]);
  });

  it("keeps the slash trigger when the editor is clicked while the picker is open", async () => {
    const user = userEvent.setup();

    render(<ChatInput {...defaultProps} />);

    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    const editor = getPromptEditor();
    await user.click(editor);
    await user.keyboard("/");
    const picker = await screen.findByTestId("context-picker-menu");
    await waitFor(() => {
      expect(picker).toBeVisible();
    });

    await user.click(editor);

    await waitFor(() => {
      expect(promptEditorText()).toBe("/");
      expect(screen.getByTestId("context-picker-menu")).toBeVisible();
    });
  });

  it("hides the picker until Radix has placed it", async () => {
    const user = userEvent.setup();
    const firstFrameVisibility: string[] = [];

    render(<ChatInput {...defaultProps} />);

    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    const observer = new MutationObserver(() => {
      const picker = screen.queryByTestId("context-picker-menu");
      if (picker && firstFrameVisibility.length === 0) {
        firstFrameVisibility.push(getComputedStyle(picker).visibility);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    try {
      const editor = getPromptEditor();
      await user.click(editor);
      await user.keyboard("/");

      await waitFor(() => {
        expect(firstFrameVisibility).toHaveLength(1);
      });

      expect(firstFrameVisibility[0]).toBe("hidden");
      await waitFor(() => {
        expect(screen.getByTestId("context-picker-menu")).toBeVisible();
      });
    } finally {
      observer.disconnect();
    }
  });

  it("reveals the picker only after the first visible frame is aligned above the editor", async () => {
    const user = userEvent.setup();
    const visibleFrames: PickerFrame[] = [];

    render(
      <div style={{ marginLeft: 240, marginTop: 420, width: 720 }}>
        <ChatInput {...defaultProps} />
      </div>,
    );

    await waitFor(() => {
      expect(window.skillsAPI.list).toHaveBeenCalled();
    });

    const editor = getPromptEditor();
    const scheduledFrames = new Set<number>();
    let isCapturing = true;

    const captureVisibleFrame = () => {
      if (!isCapturing) {
        return;
      }
      const picker = screen.queryByTestId("context-picker-menu");
      if (
        picker &&
        visibleFrames.length === 0 &&
        getComputedStyle(picker).visibility === "visible"
      ) {
        isCapturing = false;
        visibleFrames.push(readPickerFrame(picker, editor));
        return;
      }
      scheduleCaptureFrame();
    };

    const scheduleCaptureFrame = () => {
      const frame = requestAnimationFrame(() => {
        scheduledFrames.delete(frame);
        captureVisibleFrame();
      });
      scheduledFrames.add(frame);
      return frame;
    };

    scheduleCaptureFrame();

    try {
      await user.click(editor);
      await user.keyboard("/");

      await waitFor(() => {
        expect(visibleFrames).toHaveLength(1);
      });

      expectPickerFrameAligned(visibleFrames[0]);
    } finally {
      isCapturing = false;
      scheduledFrames.forEach((frame) => cancelAnimationFrame(frame));
      scheduledFrames.clear();
    }
  });
});

describe("ChatInput workspace role selector (browser)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSessionDrafts();
    installMockAPIs({
      skillsAPI: {
        list: vi.fn<SkillsAPI["list"]>().mockResolvedValue({ success: true, skills: [] }),
        onChanged: vi.fn<SkillsAPI["onChanged"]>().mockReturnValue(() => {}),
      },
      workspaceAPI: {
        listWorkspaces: vi.fn<WorkspaceAPI["listWorkspaces"]>().mockResolvedValue({
          success: true,
          workspaces: ["A workspace with a deliberately long name"],
          workspaceBindings: [
            {
              name: "A workspace with a deliberately long name",
              identity: {
                version: 1,
                device: "1",
                inode: "2",
                birthtimeNs: "3",
              },
            },
          ],
        }),
        listRepositoryAgents: vi.fn<WorkspaceAPI["listRepositoryAgents"]>().mockResolvedValue({
          success: true,
          agents: [
            {
              name: "A deliberately long reviewer role",
              path: ".github/agents/reviewer.agent.md",
              identity: {
                version: 1,
                normalizedPath: ".github/agents/reviewer.agent.md",
                declaredName: "A deliberately long reviewer role",
                contentDigest: "reviewer-v1",
              },
            },
          ],
        }),
      },
    });
  });

  afterEach(() => {
    _clearSessionDrafts();
  });

  it("keeps the editor usable and the selector within the viewport in a narrow composer", async () => {
    const user = userEvent.setup();
    render(
      <NarrowChatInput
        {...defaultProps}
        width={420}
        workspaceName="A workspace with a deliberately long name"
        workspaceIdentity={{
          version: 1,
          device: "1",
          inode: "2",
          birthtimeNs: "3",
        }}
        repositoryAgent={{
          name: "A deliberately long reviewer role",
          path: ".github/agents/reviewer.agent.md",
          identity: {
            version: 1,
            normalizedPath: ".github/agents/reviewer.agent.md",
            declaredName: "A deliberately long reviewer role",
            contentDigest: "reviewer-v1",
          },
        }}
        onWorkspaceRoleChange={vi.fn<
          NonNullable<React.ComponentProps<typeof ChatInput>["onWorkspaceRoleChange"]>
        >(async () => undefined)}
      />,
    );

    const trigger = await screen.findByTestId("workspace-role-trigger");
    const editor = getEditor();
    await waitFor(() => {
      expect(trigger).toHaveTextContent(
        "A workspace with a deliberately long name · A deliberately long reviewer role",
      );
      expect(trigger.getBoundingClientRect().width).toBeLessThanOrEqual(160);
      expect(editor.getBoundingClientRect().width).toBeGreaterThan(80);
    });

    await browserUserEvent.click(editor);
    await browserUserEvent.keyboard("composer remains usable");
    await waitFor(() => expect(editorText()).toBe("composer remains usable"));

    await user.click(trigger);
    const dialog = await screen.findByTestId("workspace-role-dialog");
    await waitFor(() => {
      expect(dialog).toBeVisible();
      expect(screen.getByLabelText("Role")).toHaveTextContent("A deliberately long reviewer role");
    });
    const dialogRect = dialog.getBoundingClientRect();
    expect(dialogRect.left).toBeGreaterThanOrEqual(0);
    expect(dialogRect.top).toBeGreaterThanOrEqual(0);
    expect(dialogRect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(dialogRect.bottom).toBeLessThanOrEqual(window.innerHeight);

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByTestId("workspace-role-dialog")).not.toBeInTheDocument(),
    );
  });
});
