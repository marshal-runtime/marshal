import { toast } from "sonner";
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createMockSessionsAPI, render, screen, waitFor, userEvent } from "@/test-utils";
import type { ModelsAPI } from "@/types/electron";

import { ModelPicker, ModelSelectionLabel } from "./ModelPicker";

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

function renderInDropdown(ui: React.ReactElement) {
  return render(
    <DropdownMenu open>
      <DropdownMenuTrigger>trigger</DropdownMenuTrigger>
      <DropdownMenuContent>{ui}</DropdownMenuContent>
    </DropdownMenu>,
  );
}

vi.mock("sonner", () => ({ toast: { error: vi.fn<(message: string) => void>() } }));

describe("ModelPicker", () => {
  it("shows loading state initially", () => {
    // Make list never resolve so we stay in loading
    vi.mocked(window.modelsAPI.list).mockReturnValue(new Promise(() => {}));

    renderInDropdown(<ModelPicker />);

    expect(screen.getByText("Loading models...")).toBeInTheDocument();
  });

  it("shows current model name after loading", async () => {
    renderInDropdown(<ModelPicker />);

    await waitFor(() => {
      expect(screen.getByText("Claude Opus 4.6")).toBeInTheDocument();
    });
  });

  it("lists the same featured models as before and keeps other models in submenu", async () => {
    renderInDropdown(<ModelPicker />);

    await waitFor(() => {
      expect(screen.getByText("Claude Opus 4.6")).toBeInTheDocument();
    });

    // Featured models are visible directly
    expect(screen.getByText("Claude Sonnet 4.6")).toBeInTheDocument();
    expect(screen.getByText("Claude Opus 4.7")).toBeInTheDocument();
    expect(screen.getByText("GPT-5.4")).toBeInTheDocument();
    expect(screen.getByText("Models")).toBeInTheDocument();
    // Unfeatured models are in the "Other models" submenu
    expect(screen.getByText("Other models")).toBeInTheDocument();
  });

  it("surfaces a selected non-featured model at the top level", async () => {
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [
        { id: "claude-opus-4.6", name: "Claude Opus 4.6", featured: true },
        { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
        { id: "o3-mini", name: "o3 Mini" },
      ],
    });
    vi.mocked(window.modelsAPI.getSessionModel).mockResolvedValue({
      success: true,
      model: "gpt-5.4-mini",
    });

    renderInDropdown(<ModelPicker sessionId="s1" />);

    // The selected non-featured model is pulled up to the top level and checked,
    // so it is visible without opening the "Other models" submenu.
    const selected = await screen.findByRole("menuitemradio", { name: /GPT-5\.4 Mini/ });
    expect(selected).toHaveAttribute("data-state", "checked");

    // Open the "Other models" submenu and verify the partition: the remaining
    // non-featured model is nested there, and the promoted model is NOT
    // duplicated inside the submenu (it appears exactly once, at the top level).
    const user = userEvent.setup();
    await user.click(screen.getByText("Other models"));
    expect(await screen.findByRole("menuitemradio", { name: /o3 Mini/ })).toBeInTheDocument();
    expect(screen.getAllByRole("menuitemradio", { name: /GPT-5\.4 Mini/ })).toHaveLength(1);
  });

  it("shows current model as selected in listbox", async () => {
    renderInDropdown(<ModelPicker />);

    await waitFor(() => {
      expect(screen.getByText("Claude Opus 4.6")).toBeInTheDocument();
    });

    // Current model (claude-opus-4.6) should be marked as checked via Radix data-state
    const items = screen.getAllByRole("menuitemradio");
    const checked = items.find((el) => el.getAttribute("data-state") === "checked");
    expect(checked).toBeTruthy();
  });

  it("calls setDefault when selecting a model", async () => {
    const user = userEvent.setup();
    renderInDropdown(<ModelPicker />);

    await waitFor(() => {
      expect(screen.getByText("Claude Opus 4.6")).toBeInTheDocument();
    });

    // Click directly on the model in the list
    await user.click(screen.getByRole("menuitemradio", { name: /GPT-5\.4/ }));

    await waitFor(() => {
      expect(window.modelsAPI.setDefault).toHaveBeenCalledWith("gpt-5.4");
    });
  });

  it("changes the model for an existing session", async () => {
    const user = userEvent.setup();
    renderInDropdown(<ModelPicker sessionId="s1" />);

    await user.click(await screen.findByRole("menuitemradio", { name: /GPT-5\.4/ }));

    await waitFor(() => {
      expect(window.sessionsAPI.setModel).toHaveBeenCalledWith("s1", "gpt-5.4");
    });
  });

  it("changes context window for an existing long-context session", async () => {
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          featured: true,
          supportedContextTiers: ["default", "long_context"],
          contextWindowTokens: { default: 272_000, long_context: 1_050_000 },
        },
      ],
    });
    vi.mocked(window.modelsAPI.getSessionModel).mockResolvedValue({
      success: true,
      model: "gpt-5.6-sol",
    });
    const user = userEvent.setup();

    renderInDropdown(<ModelPicker sessionId="s1" />);
    await user.click(await screen.findByRole("menuitemradio", { name: "272K" }));

    await waitFor(() => {
      expect(window.modelsAPI.setSessionContextTier).toHaveBeenCalledWith("s1", "default");
    });
  });

  it("rolls back an existing session selection when the model change fails", async () => {
    vi.mocked(window.sessionsAPI.setModel).mockResolvedValueOnce({
      success: false,
      error: "Model is unavailable",
    });
    const user = userEvent.setup();
    renderInDropdown(<ModelPicker sessionId="s1" />);

    await user.click(await screen.findByRole("menuitemradio", { name: /GPT-5\.4/ }));

    await waitFor(() => {
      const current = screen.getByRole("menuitemradio", { name: /Claude Opus 4\.6/ });
      expect(current).toHaveAttribute("data-state", "checked");
    });
  });

  it("shows disabled state when disabled=true", async () => {
    renderInDropdown(<ModelPicker disabled />);

    await waitFor(() => {
      expect(screen.getByText("Claude Opus 4.6")).toBeInTheDocument();
    });

    // All radio items in the list should be disabled
    const items = screen.getAllByRole("menuitemradio");
    items.forEach((item) => expect(item).toHaveAttribute("data-disabled"));
  });
});

describe("ModelPicker across runtimes", () => {
  const claude = { runtimeId: "claude", label: "Claude Agent" };
  const codex = { runtimeId: "codex", label: "Codex" };
  const work = { runtimeId: "claude", accountId: "work", label: "Claude Agent · work" };

  beforeEach(() => {
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [
        { id: "opus", name: "Opus", featured: true, runtime: claude },
        { id: "codex:gpt-5.6-sol", name: "GPT-5.6 Sol", runtime: codex },
        { id: "codex:gpt-5.5", name: "GPT-5.5", runtime: codex },
        { id: "claude@work:opus", name: "Opus", runtime: work },
      ],
    });
    vi.mocked(window.modelsAPI.getSessionModel).mockResolvedValue({ success: true, model: "opus" });
    vi.mocked(window.modelsAPI.getDefault).mockResolvedValue({ success: true, model: "opus" });
  });

  it("groups models under a heading per runtime account, active runtime first", async () => {
    renderInDropdown(<ModelPicker sessionId="s1" />);

    await screen.findByRole("menuitemradio", { name: /GPT-5\.6 Sol/ });
    const headings = screen.getAllByTestId("model-group-label").map((el) => el.textContent);
    expect(headings).toEqual(["Claude Agent", "Codex", "Claude Agent · work"]);
  });

  it("switches a chat to a model of another runtime with its qualified id", async () => {
    const user = userEvent.setup();
    renderInDropdown(<ModelPicker sessionId="s1" />);

    await user.click(await screen.findByRole("menuitemradio", { name: /GPT-5\.6 Sol/ }));

    await waitFor(() => {
      expect(window.sessionsAPI.setModel).toHaveBeenCalledWith("s1", "codex:gpt-5.6-sol");
    });
  });

  it("shows which runtime the current model runs on when it is not the active one", async () => {
    vi.mocked(window.modelsAPI.getSessionModel).mockResolvedValue({
      success: true,
      model: "codex:gpt-5.5",
    });

    renderInDropdown(<ModelPicker sessionId="s1" />);

    expect(await screen.findByTestId("model-picker-current-runtime")).toHaveTextContent(
      "Running on Codex",
    );
  });

  it("does not show the runtime line or group headings for a single runtime", async () => {
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [{ id: "opus", name: "Opus", featured: true, runtime: claude }],
    });

    renderInDropdown(<ModelPicker sessionId="s1" />);

    await screen.findByRole("menuitemradio", { name: /Opus/ });
    expect(screen.queryByTestId("model-group-label")).not.toBeInTheDocument();
    expect(screen.queryByTestId("model-picker-current-runtime")).not.toBeInTheDocument();
  });

  it("labels the trigger with the selected model and its runtime, and follows a new pick", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>
          <ModelSelectionLabel sessionId="s1" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <ModelPicker sessionId="s1" />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const label = await screen.findByTestId("model-selection-label");
    await waitFor(() => expect(label).toHaveTextContent(/^OpusClaude Agent$/));

    vi.mocked(window.sessionsAPI.setModel).mockImplementationOnce(async (_sessionId, model) => {
      vi.mocked(window.modelsAPI.getSessionModel).mockResolvedValue({ success: true, model });
      return { success: true };
    });
    await user.click(await screen.findByRole("menuitemradio", { name: /GPT-5\.6 Sol/ }));

    await waitFor(() =>
      expect(screen.getByTestId("model-selection-label")).toHaveTextContent(/^GPT-5\.6 SolCodex$/),
    );
  });

  it("labels the trigger with the model only when there is a single runtime", async () => {
    vi.mocked(window.modelsAPI.list).mockResolvedValue({
      success: true,
      models: [{ id: "opus", name: "Opus", featured: true, runtime: claude }],
    });

    render(<ModelSelectionLabel sessionId="s1" />);

    await waitFor(() =>
      expect(screen.getByTestId("model-selection-label")).toHaveTextContent("Opus"),
    );
    expect(screen.getByTestId("model-selection-label")).not.toHaveTextContent("Claude Agent");
  });

  it("tells the user when the model switch fails", async () => {
    vi.mocked(window.sessionsAPI.setModel).mockResolvedValue({
      success: false,
      error: "Codex is not signed in",
    });
    const user = userEvent.setup();
    renderInDropdown(<ModelPicker sessionId="s1" />);

    await user.click(await screen.findByRole("menuitemradio", { name: /GPT-5\.5/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Codex is not signed in");
    });
  });
});
