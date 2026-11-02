import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { act, render, screen, waitFor } from "@/test-utils";
import type { ContextPickerAPI, Skill, WorkspaceAPI } from "@/types/electron";

import type { InputEditorHandle } from "../editor/InputEditor";
import { PickerController } from "./PickerController";

beforeEach(() => {
  Object.defineProperty(window, "contextPickerAPI", {
    configurable: true,
    writable: true,
    value: {
      search: vi
        .fn<ContextPickerAPI["search"]>()
        .mockResolvedValue({ success: true, entities: [] }),
    },
  });
  Object.defineProperty(window, "workspaceAPI", {
    configurable: true,
    writable: true,
    value: {
      searchFiles: vi.fn<WorkspaceAPI["searchFiles"]>().mockResolvedValue({
        success: true,
        files: [],
      }),
    } as Partial<WorkspaceAPI>,
  });
});

afterEach(() => {
  // jsdom shares the global across test files; clean up our stub.
  Reflect.deleteProperty(window, "contextPickerAPI");
  Reflect.deleteProperty(window, "workspaceAPI");
});

async function showPeopleTab() {
  await userEvent.setup().click(await screen.findByRole("tab", { name: /people/i }));
}

const testSkill: Skill = {
  id: "skill-review",
  name: "review",
  description: "Review code",
  instructions: "Review code",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  scope: "local",
};
const stableTestSkills = [testSkill];

describe("PickerController tab switching", () => {
  function HarnessWithEntities({ queryClient }: { queryClient: QueryClient }) {
    const editorRef = useRef<InputEditorHandle | null>(null);
    return (
      <QueryClientProvider client={queryClient}>
        <PickerController input=" @" editorRef={editorRef} skills={[]} setInputAndEditor={() => {}}>
          {({ menu, setAnchorEl }) => (
            <>
              <div ref={setAnchorEl} />
              {menu}
            </>
          )}
        </PickerController>
      </QueryClientProvider>
    );
  }

  it("clicking the Files tab hides People rows and shows File rows", async () => {
    // Mock the IPC to return both People and File entities so both tabs
    // have content to show.
    vi.mocked(window.contextPickerAPI!.search).mockResolvedValue({
      success: true,
      entities: [
        { type: "People", id: "p1", referenceId: "p1", displayName: "Alice Person" },
        { type: "People", id: "p2", referenceId: "p2", displayName: "Bob Person" },
        {
          type: "File",
          id: "f1",
          referenceId: "f1",
          title: "Report.docx",
          fileExtension: "docx",
        },
      ],
    });
    window.workspaceAPI.searchFiles = vi.fn<WorkspaceAPI["searchFiles"]>().mockResolvedValue({
      success: true,
      files: [
        {
          type: "File",
          id: "/workspace/Report.docx",
          referenceId: "/workspace/Report.docx",
          title: "Report.docx",
          fileExtension: "docx",
          localPath: "/workspace/Report.docx",
        },
      ],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(<HarnessWithEntities queryClient={queryClient} />);

    await showPeopleTab();

    // The @ trigger opens on Files, so switch to People first.
    // Wait for People rows to render.
    expect(await screen.findByRole("option", { name: /alice person/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /bob person/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /report\.docx/i })).toBeNull();

    // Click Files tab.
    const filesTab = screen.getByRole("tab", { name: /files/i });
    await userEvent.setup().click(filesTab);

    // After click: People rows are gone, File rows are visible.
    expect(screen.queryByRole("option", { name: /alice person/i })).toBeNull();
    expect(screen.queryByRole("option", { name: /bob person/i })).toBeNull();
    expect(await screen.findByRole("option", { name: /report\.docx/i })).toBeInTheDocument();
  });

  it("dispatching mousedown directly on the Files tab also switches the tab (real-browser flow)", async () => {
    // userEvent.click() simulates the full pointer flow; this test uses raw
    // MouseEvent dispatch to mirror what Radix Tabs sees in the live app
    // when our onMouseDown handler runs.
    vi.mocked(window.contextPickerAPI!.search).mockResolvedValue({
      success: true,
      entities: [
        { type: "People", id: "p1", referenceId: "p1", displayName: "Alice Person" },
        {
          type: "File",
          id: "f1",
          referenceId: "f1",
          title: "Report.docx",
          fileExtension: "docx",
        },
      ],
    });
    window.workspaceAPI.searchFiles = vi.fn<WorkspaceAPI["searchFiles"]>().mockResolvedValue({
      success: true,
      files: [
        {
          type: "File",
          id: "/workspace/Report.docx",
          referenceId: "/workspace/Report.docx",
          title: "Report.docx",
          fileExtension: "docx",
          localPath: "/workspace/Report.docx",
        },
      ],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(<HarnessWithEntities queryClient={queryClient} />);

    await showPeopleTab();

    expect(await screen.findByRole("option", { name: /alice person/i })).toBeInTheDocument();

    const filesTab = screen.getByRole("tab", { name: /files/i });

    // Dispatch a real MouseEvent("mousedown") which is what our onMouseDown
    // handler receives in the live app — userEvent has its own simulation
    // that may behave differently.
    const mousedown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    act(() => {
      filesTab.dispatchEvent(mousedown);
    });

    await waitFor(() => {
      expect(screen.queryByRole("option", { name: /alice person/i })).toBeNull();
    });
    expect(await screen.findByRole("option", { name: /report\.docx/i })).toBeInTheDocument();
  });

  it("People rows each have a unique data-value, exactly one is data-selected (regression for entityValue collapse)", async () => {
    // Regression pin: entityValue() previously composed `${type}:${referenceId}`,
    // but People entities don't carry a `referenceId` (only File entities
    // do), so every People row collapsed to value "People:undefined".
    // cmdk then marked every row as data-selected="true" because they all
    // matched the controlled value. Symptom in the live app: "all people
    // look selected".
    vi.mocked(window.contextPickerAPI!.search).mockResolvedValue({
      success: true,
      entities: [
        // Note: no referenceId on People — matches the real IPC parser shape.
        { type: "People", id: "p1", displayName: "Alice Person" },
        { type: "People", id: "p2", displayName: "Bob Person" },
        { type: "People", id: "p3", displayName: "Dana Person" },
      ],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(<HarnessWithEntities queryClient={queryClient} />);
    await showPeopleTab();

    await screen.findByRole("option", { name: /alice/i });

    const peopleOpts = screen.getAllByRole("option");
    expect(peopleOpts.length).toBe(3);

    // Each row must have a unique data-value (cmdk's identity for
    // selection); duplicate values would make multiple rows match.
    const values = peopleOpts.map((o) => o.getAttribute("data-value"));
    expect(new Set(values).size).toBe(values.length);

    // Only one row should be highlighted at any time.
    const selectedCount = peopleOpts.filter(
      (o) => o.getAttribute("data-selected") === "true",
    ).length;
    expect(selectedCount).toBe(1);
  });
});

describe("PickerController ARIA ids", () => {
  it("exposes deterministic listbox and active descendant ids", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const capturedIds = {
      listboxId: undefined as string | undefined,
      activeDescendantId: undefined as string | undefined,
    };

    function AriaIdHarness() {
      const [input, setInput] = useState("/");
      const editorRef = useRef<InputEditorHandle | null>(null);
      return (
        <QueryClientProvider client={queryClient}>
          <PickerController
            input={input}
            editorRef={editorRef}
            skills={stableTestSkills}
            setInputAndEditor={setInput}
          >
            {({ menu, setAnchorEl, pickerListboxId, pickerActiveDescendantId }) => {
              // Capture ids without causing linter warnings by using an object mutation
              Object.assign(capturedIds, {
                listboxId: pickerListboxId,
                activeDescendantId: pickerActiveDescendantId,
              });
              return (
                <>
                  <div ref={setAnchorEl} />
                  {menu}
                </>
              );
            }}
          </PickerController>
        </QueryClientProvider>
      );
    }

    render(<AriaIdHarness />);

    await screen.findByRole("option", { name: /\/review/i });

    expect(capturedIds.listboxId).toBe("context-picker-listbox");
    expect(capturedIds.activeDescendantId).toBe("context-picker-option-skill-review");
  });
});

describe("PickerController built-in /goal command", () => {
  function CommandHarness({
    queryClient,
    initialInput,
    onSetInput,
  }: {
    queryClient: QueryClient;
    initialInput: string;
    onSetInput?: (value: string) => void;
  }) {
    const [input, setInput] = useState(initialInput);
    const editorRef = useRef<InputEditorHandle | null>(null);
    return (
      <QueryClientProvider client={queryClient}>
        <PickerController
          input={input}
          editorRef={editorRef}
          skills={[]}
          setInputAndEditor={(value) => {
            onSetInput?.(value);
            setInput(value);
          }}
        >
          {({ menu, setAnchorEl }) => (
            <>
              <div ref={setAnchorEl} />
              {menu}
            </>
          )}
        </PickerController>
      </QueryClientProvider>
    );
  }

  it("surfaces the /goal command when the query matches, even with no skills", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<CommandHarness queryClient={queryClient} initialInput="/goal" />);

    // The Skills tab would otherwise show "No matching skills"; the built-in
    // command makes /goal discoverable like a skill.
    const option = await screen.findByRole("option", { name: /\/goal/i });
    expect(option).toBeInTheDocument();
  });

  it("fills the editor with '/goal ' when the command is selected", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const setInput = vi.fn<(value: string) => void>();
    const user = userEvent.setup();
    render(<CommandHarness queryClient={queryClient} initialInput="/goal" onSetInput={setInput} />);

    const option = await screen.findByRole("option", { name: /\/goal/i });
    await user.click(option);

    expect(setInput).toHaveBeenCalledWith("/goal ");
  });
});
