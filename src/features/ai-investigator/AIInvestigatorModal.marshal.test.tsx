// marshal-owned renderer test
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";
import type { AIInvestigatorEvent, AIInvestigatorAPI } from "@/types/electron";

import { AIInvestigatorModal } from "./AIInvestigatorModal";
import { useAIInvestigator } from "./useAIInvestigator";

/** Test-only host that owns the hook the same way AIInvestigatorButton does in
 *  prod. Keeps the modal under test pure (props-only) and avoids the
 *  double-subscription bug that motivated lifting useAIInvestigator up. */
function ModalHost({ onOpenChange = () => {} }: { onOpenChange?: (open: boolean) => void } = {}) {
  const fb = useAIInvestigator();
  return <AIInvestigatorModal open onOpenChange={onOpenChange} fb={fb} />;
}

function setupAPI(overrides: Partial<AIInvestigatorAPI> = {}) {
  let listener: ((e: AIInvestigatorEvent) => void) | null = null;
  const onEvent = vi.fn<AIInvestigatorAPI["onEvent"]>((cb) => {
    listener = cb;
    return () => {
      listener = null;
    };
  });
  installMockAPIs({
    aiInvestigatorAPI: {
      onEvent,
      ...overrides,
    },
  });
  return {
    api: window.aiInvestigatorAPI!,
    emit: (e: AIInvestigatorEvent) => listener?.(e),
  };
}

describe("AIInvestigatorModal — intake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the consent label verbatim", async () => {
    setupAPI();
    render(<ModalHost />);
    expect(
      await screen.findByText(
        "I understand my diagnostics log will be sent to the AI for analysis.",
      ),
    ).toBeInTheDocument();
  });

  it("disables submit until both description AND consent are provided", async () => {
    const user = userEvent.setup();
    setupAPI();
    render(<ModalHost />);
    const submit = await screen.findByRole("button", { name: "Investigate" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/one-line description/i), "broken");
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole("checkbox"));
    expect(submit).toBeEnabled();
  });

  it("calls api.start when submit is clicked", async () => {
    const user = userEvent.setup();
    const fx = setupAPI();
    render(<ModalHost />);
    await user.type(screen.getByPlaceholderText(/one-line description/i), "broke");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Investigate" }));
    await waitFor(() =>
      expect(fx.api.start).toHaveBeenCalledWith(
        expect.objectContaining({ userDescription: "broke" }),
      ),
    );
  });
});

describe("AIInvestigatorModal — investigating view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the progress log when investigating", async () => {
    const fx = setupAPI();
    render(<ModalHost />);
    expect(await screen.findByTestId("ai-investigator-view-intake")).toBeInTheDocument();
    fx.emit({ type: "status", state: "investigating" });
    fx.emit({ type: "progress", message: "Tool: gh search" });
    expect(await screen.findByTestId("ai-investigator-view-investigating")).toBeInTheDocument();
    expect(screen.getByText("Tool: gh search")).toBeInTheDocument();
  });

  it("switches to progress view immediately while start is still pending", async () => {
    const user = userEvent.setup();
    setupAPI({
      start: vi.fn<AIInvestigatorAPI["start"]>(() => new Promise(() => {})),
    });
    render(<ModalHost />);
    await user.type(screen.getByPlaceholderText(/one-line description/i), "broke");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Investigate" }));

    expect(await screen.findByTestId("ai-investigator-view-investigating")).toBeInTheDocument();
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-investigator-view-intake")).not.toBeInTheDocument();
  });
});

describe("AIInvestigatorModal — summary + post", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the read-only report and a file-to-tracker button when ready", async () => {
    const fx = setupAPI();
    render(<ModalHost />);
    expect(await screen.findByTestId("ai-investigator-view-intake")).toBeInTheDocument();
    fx.emit({ type: "ready", title: "Big bug", body: "## Summary\nstuff" });
    expect(await screen.findByTestId("ai-investigator-view-summary")).toBeInTheDocument();
    expect(screen.getByText("Big bug")).toBeInTheDocument();
    expect(screen.getByTestId("ai-investigator-summary-body").textContent).toContain("## Summary");
    expect(screen.getByRole("button", { name: /^File to / })).toBeEnabled();
  });

  it("calls api.post when the file-to-tracker button is clicked", async () => {
    const user = userEvent.setup();
    const fx = setupAPI();
    render(<ModalHost />);
    expect(await screen.findByTestId("ai-investigator-view-intake")).toBeInTheDocument();
    fx.emit({ type: "ready", title: "T", body: "B" });
    expect(await screen.findByTestId("ai-investigator-view-summary")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^File to / }));
    await waitFor(() => expect(fx.api.post).toHaveBeenCalled());
  });
});

describe("AIInvestigatorModal — error view (ST-S3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows error message and Try Again calls reset() then transitions to intake", async () => {
    const user = userEvent.setup();
    const fx = setupAPI();
    render(<ModalHost />);
    expect(await screen.findByTestId("ai-investigator-view-intake")).toBeInTheDocument();
    fx.emit({ type: "error", error: "boom" });
    expect(await screen.findByTestId("ai-investigator-view-error")).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fx.api.reset).toHaveBeenCalled());
    // After reset succeeds, snapshot returns to idle → intake view shown.
    expect(await screen.findByTestId("ai-investigator-view-intake")).toBeInTheDocument();
  });
});

describe("AIInvestigatorModal — posted view (ST-S3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the issue URL link and opens it via shellAPI", async () => {
    const user = userEvent.setup();
    const fx = setupAPI();
    render(<ModalHost />);
    expect(await screen.findByTestId("ai-investigator-view-intake")).toBeInTheDocument();
    fx.emit({ type: "posted", issueUrl: "https://github.com/OmerMachluf/marshal/issues/123" });
    expect(await screen.findByTestId("ai-investigator-view-posted")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "View issue" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "https://github.com/OmerMachluf/marshal/issues/123");

    await user.click(link);
    await waitFor(() =>
      expect(window.shellAPI?.openExternal).toHaveBeenCalledWith(
        "https://github.com/OmerMachluf/marshal/issues/123",
      ),
    );
  });
});
