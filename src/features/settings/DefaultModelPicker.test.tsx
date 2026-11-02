import { describe, it, expect, vi, beforeEach } from "vitest";

import { render, screen, waitFor, userEvent, installMockAPIs } from "@/test-utils";
import type { ModelsAPI } from "@/types/electron";

import { DefaultModelPicker } from "./DefaultModelPicker";

beforeEach(() => {
  installMockAPIs({
    modelsAPI: {
      list: vi.fn<ModelsAPI["list"]>().mockResolvedValue({
        success: true,
        models: [
          { id: "gpt-4o", name: "GPT-4o", featured: true },
          {
            id: "claude-sonnet-4",
            name: "Claude Sonnet 4",
            capabilities: { supports: { reasoningEffort: true } },
            supportedReasoningEfforts: ["low", "medium", "high"],
            defaultReasoningEffort: "medium",
          },
          { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
        ],
      }),
      getDefault: vi
        .fn<ModelsAPI["getDefault"]>()
        .mockResolvedValue({ success: true, model: "gpt-4o" }),
      setDefault: vi.fn<ModelsAPI["setDefault"]>().mockResolvedValue({ success: true }),
      getDefaultReasoningEffort: vi
        .fn<ModelsAPI["getDefaultReasoningEffort"]>()
        .mockResolvedValue({ success: true }),
      setDefaultReasoningEffort: vi
        .fn<ModelsAPI["setDefaultReasoningEffort"]>()
        .mockResolvedValue({ success: true }),
    },
  });
});

describe("DefaultModelPicker", () => {
  it("does not render when not enabled", () => {
    render(<DefaultModelPicker enabled={false} />);
    expect(screen.queryByTestId("default-model-select")).not.toBeInTheDocument();
  });

  it("shows model dropdown when enabled", async () => {
    render(<DefaultModelPicker enabled={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("default-model-select")).toBeInTheDocument();
    });
    // shadcn Select shows the selected value in the trigger
    expect(screen.getByText("GPT-4o")).toBeInTheDocument();
  });

  it("shows current default model as selected", async () => {
    render(<DefaultModelPicker enabled={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("default-model-select")).toBeInTheDocument();
    });
    expect(screen.getByTestId("default-model-select")).toHaveTextContent("GPT-4o");
  });

  it("calls setDefault when selection changes", async () => {
    const user = userEvent.setup();
    render(<DefaultModelPicker enabled={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("default-model-select")).toBeInTheDocument();
    });

    // Open the select dropdown
    await user.click(screen.getByTestId("default-model-select"));
    // Click the desired option
    await user.click(screen.getByText("Claude Sonnet 4"));

    expect(window.modelsAPI.setDefault).toHaveBeenCalledWith("claude-sonnet-4");
  });

  it("keeps newly discovered unfeatured models selectable", async () => {
    const user = userEvent.setup();
    render(<DefaultModelPicker enabled={true} />);
    await waitFor(() => {
      expect(screen.getByTestId("default-model-select")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("default-model-select"));

    expect(screen.getByText("Claude Opus 4.7")).toBeInTheDocument();
  });

  it("shows reasoning effort options for models that support them", async () => {
    vi.mocked(window.modelsAPI.getDefault).mockResolvedValue({
      success: true,
      model: "claude-sonnet-4",
    });

    render(<DefaultModelPicker enabled={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("default-reasoning-effort-select")).toBeInTheDocument();
    });
    // System default is High where the model supports it (claude-sonnet-4
    // supports low/medium/high), so the "Auto" option surfaces High.
    expect(screen.getByTestId("default-reasoning-effort-select")).toHaveTextContent("Auto (High)");
  });

  it("persists selected reasoning effort for the current default model", async () => {
    const user = userEvent.setup();
    vi.mocked(window.modelsAPI.getDefault).mockResolvedValue({
      success: true,
      model: "claude-sonnet-4",
    });

    render(<DefaultModelPicker enabled={true} />);

    await waitFor(() => {
      expect(screen.getByTestId("default-reasoning-effort-select")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("default-reasoning-effort-select"));
    await user.click(screen.getByText("High"));

    expect(window.modelsAPI.setDefaultReasoningEffort).toHaveBeenCalledWith(
      "claude-sonnet-4",
      "high",
    );
  });

  it("persists the selected context window for a long-context model", async () => {
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          supportedContextTiers: ["default", "long_context"],
          contextWindowTokens: { default: 272_000, long_context: 1_050_000 },
        },
      ],
    });
    vi.mocked(window.modelsAPI.getDefault).mockResolvedValue({
      success: true,
      model: "gpt-5.6-sol",
    });
    vi.mocked(window.modelsAPI.getDefaultContextTier).mockResolvedValue({
      success: true,
      contextTier: "long_context",
    });
    const user = userEvent.setup();

    render(<DefaultModelPicker enabled={true} />);

    await user.click(await screen.findByTestId("default-context-select"));
    await user.click(screen.getByText("272K"));

    expect(window.modelsAPI.setDefaultContextTier).toHaveBeenCalledWith(
      "gpt-5.6-sol",
      "default",
    );
  });
});
