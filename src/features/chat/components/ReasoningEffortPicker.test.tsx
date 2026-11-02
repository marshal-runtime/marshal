import { describe, it, expect, vi, beforeEach } from "vitest";

import { createMockSessionsAPI, render, screen, waitFor, userEvent } from "@/test-utils";
import type { ModelsAPI } from "@/types/electron";

import { ReasoningEffortPicker } from "./ReasoningEffortPicker";

beforeEach(() => {
  window.sessionsAPI = createMockSessionsAPI();
  window.modelsAPI = {
    list: vi.fn<ModelsAPI["list"]>().mockResolvedValue({
      success: true,
      models: [
        { id: "claude-opus-4.6", name: "Claude Opus 4.6", featured: true },
        { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", featured: true },
        { id: "claude-opus-4.7", name: "Claude Opus 4.7", featured: true },
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          featured: true,
          billing: { isPremium: true, premiumMultiplier: 2 },
        },
        { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", billing: { isPremium: false } },
      ],
    }),
    getDefault: vi
      .fn<ModelsAPI["getDefault"]>()
      .mockResolvedValue({ success: true, model: "claude-opus-4.6" }),
    setDefault: vi.fn<ModelsAPI["setDefault"]>().mockResolvedValue({ success: true }),
    getDefaultReasoningEffort: vi
      .fn<ModelsAPI["getDefaultReasoningEffort"]>()
      .mockResolvedValue({ success: true }),
    setDefaultReasoningEffort: vi
      .fn<ModelsAPI["setDefaultReasoningEffort"]>()
      .mockResolvedValue({ success: true }),
    getDefaultContextTier: vi
      .fn<ModelsAPI["getDefaultContextTier"]>()
      .mockResolvedValue({ success: true }),
    setDefaultContextTier: vi
      .fn<ModelsAPI["setDefaultContextTier"]>()
      .mockResolvedValue({ success: true }),
    getSessionModel: vi
      .fn<ModelsAPI["getSessionModel"]>()
      .mockResolvedValue({ success: true, model: "claude-opus-4.6" }),
    getSessionReasoningEffort: vi
      .fn<ModelsAPI["getSessionReasoningEffort"]>()
      .mockResolvedValue({ success: true }),
    setSessionReasoningEffort: vi
      .fn<ModelsAPI["setSessionReasoningEffort"]>()
      .mockResolvedValue({ success: true }),
    getSessionContextTier: vi
      .fn<ModelsAPI["getSessionContextTier"]>()
      .mockResolvedValue({ success: true }),
    setSessionContextTier: vi
      .fn<ModelsAPI["setSessionContextTier"]>()
      .mockResolvedValue({ success: true }),
    getTierDefaults: vi
      .fn<ModelsAPI["getTierDefaults"]>()
      .mockResolvedValue({ success: true, defaults: {} }),
    setTierDefaultModel: vi
      .fn<ModelsAPI["setTierDefaultModel"]>()
      .mockResolvedValue({ success: true }),
    setTierDefaultReasoningEffort: vi
      .fn<ModelsAPI["setTierDefaultReasoningEffort"]>()
      .mockResolvedValue({ success: true }),
    setTierDefaultContextTier: vi
      .fn<ModelsAPI["setTierDefaultContextTier"]>()
      .mockResolvedValue({ success: true }),
    onChanged: vi.fn<ModelsAPI["onChanged"]>().mockReturnValue(() => {}),
  };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn<(message: string) => void>() } }));

const reasoningModel = {
  id: "claude-opus-4.6",
  name: "Claude Opus 4.6",
  featured: true,
  supportedReasoningEfforts: ["low", "high"] as ("low" | "high")[],
};

describe("ReasoningEffortPicker", () => {
  it("changes reasoning effort for an existing session", async () => {
    vi.mocked(window.modelsAPI.list).mockResolvedValue({ success: true, models: [reasoningModel] });
    const user = userEvent.setup();
    render(<ReasoningEffortPicker sessionId="s1" />);

    await user.click(await screen.findByRole("button", { name: "Reasoning effort" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Low" }));

    await waitFor(() => {
      expect(window.modelsAPI.setSessionReasoningEffort).toHaveBeenCalledWith("s1", "low");
    });
  });

  it("returns to the automatic level when Auto is picked", async () => {
    vi.mocked(window.modelsAPI.list).mockResolvedValue({ success: true, models: [reasoningModel] });
    vi.mocked(window.modelsAPI.getSessionReasoningEffort).mockResolvedValue({
      success: true,
      effort: "low",
    });
    const user = userEvent.setup();
    render(<ReasoningEffortPicker sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByTestId("reasoning-effort-label")).toHaveTextContent("Low");
    });
    await user.click(screen.getByRole("button", { name: "Reasoning effort" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /^Auto/ }));

    await waitFor(() => {
      expect(window.modelsAPI.setSessionReasoningEffort).toHaveBeenCalledWith("s1", undefined);
    });
  });

  it("renders nothing for a model without reasoning levels", async () => {
    render(<ReasoningEffortPicker sessionId="s1" />);

    await waitFor(() => {
      expect(window.modelsAPI.list).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button", { name: "Reasoning effort" })).not.toBeInTheDocument();
  });

  it("renders nothing before the chat has a session", async () => {
    vi.mocked(window.modelsAPI.list).mockResolvedValue({ success: true, models: [reasoningModel] });
    render(<ReasoningEffortPicker sessionId={null} />);

    await waitFor(() => {
      expect(window.modelsAPI.list).toHaveBeenCalled();
    });
    expect(screen.queryByRole("button", { name: "Reasoning effort" })).not.toBeInTheDocument();
  });
});
