// marshal-owned renderer test
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, waitFor } from "@/test-utils";
import type { AIInvestigatorAPI, AIInvestigatorEvent } from "@/types/electron";

import { AIInvestigatorButton } from "./AIInvestigatorButton";

function setupAPI(overrides: Partial<AIInvestigatorAPI> = {}) {
  let listener: ((e: AIInvestigatorEvent) => void) | null = null;
  const onEvent = vi.fn<AIInvestigatorAPI["onEvent"]>((cb) => {
    listener = cb;
    return () => {
      listener = null;
    };
  });
  installMockAPIs({
    aiInvestigatorAPI: { onEvent, ...overrides },
  });
  return {
    api: window.aiInvestigatorAPI!,
    emit: (e: AIInvestigatorEvent) => listener?.(e),
  };
}

describe("AIInvestigatorButton — tooltip (W6a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows default tooltip text when idle", async () => {
    const user = userEvent.setup();
    setupAPI();
    render(<AIInvestigatorButton />);
    const btn = await screen.findByTestId("ai-investigator-button");
    await user.hover(btn);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Report a bug");
  });

  it("shows busy tooltip when investigation is running", async () => {
    const user = userEvent.setup();
    const fx = setupAPI();
    render(<AIInvestigatorButton />);
    const btn = await screen.findByTestId("ai-investigator-button");
    fx.emit({ type: "status", state: "investigating" });
    await waitFor(() => expect(btn).toHaveAttribute("aria-label", "Investigation in progress…"));
    await user.hover(btn);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Investigation in progress…");
  });

  it("shows ready tooltip when report is waiting", async () => {
    const user = userEvent.setup();
    const fx = setupAPI();
    render(<AIInvestigatorButton />);
    await screen.findByTestId("ai-investigator-button");
    fx.emit({ type: "ready", title: "T", body: "B" });
    const btn = await screen.findByTestId("ai-investigator-button");
    await waitFor(() =>
      expect(btn).toHaveAttribute("aria-label", "Bug report ready — click to review"),
    );
    await user.hover(btn);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Bug report ready — click to review",
    );
  });
});

describe("AIInvestigatorButton — availability (W7-header)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the button when available: true", async () => {
    setupAPI(); // default mock returns available: true
    render(<AIInvestigatorButton />);
    expect(await screen.findByTestId("ai-investigator-button")).toBeInTheDocument();
  });

  it("does not render the button when available: false", async () => {
    setupAPI({
      checkAvailability: vi
        .fn<AIInvestigatorAPI["checkAvailability"]>()
        .mockResolvedValue({ success: true, available: false }),
    });
    render(<AIInvestigatorButton />);
    await waitFor(() =>
      expect(screen.queryByTestId("ai-investigator-button")).not.toBeInTheDocument(),
    );
  });
});
