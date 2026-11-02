// marshal-owned renderer test
import { describe, expect, it, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, userEvent } from "@/test-utils";

import { INITIAL_AUTOMATION_FORM_STATE, type AutomationFormState } from "./automation-form-state";
import { AutomationFormView } from "./AutomationFormView";

function makeProps(stateOverrides: Partial<AutomationFormState> = {}) {
  return {
    mode: "edit" as const,
    state: { ...INITIAL_AUTOMATION_FORM_STATE, ...stateOverrides },
    onChange: vi.fn<(patch: Partial<AutomationFormState>) => void>(),
    onManagePermissions: vi.fn<() => void>(),
    onCustomizePermissions: vi.fn<() => void>(),
    onSave: vi.fn<() => void>(),
    onCancel: vi.fn<() => void>(),
  };
}

describe("AutomationFormView model selector (browser)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMockAPIs();
  });

  it("renders the model selector", async () => {
    render(<AutomationFormView {...makeProps()} />);
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: /model/i })).toBeInTheDocument();
  });

  it("selects a per-automation model from the real dropdown", async () => {
    const user = userEvent.setup();
    const props = makeProps();

    render(<AutomationFormView {...props} />);

    await user.click(await screen.findByRole("combobox", { name: /model/i }));
    await user.click(await screen.findByText("GPT-5.4 Mini"));

    expect(props.onChange).toHaveBeenCalledWith({ model: "gpt-5.4-mini" });
  });

  it("emits undefined when global default is selected", async () => {
    const user = userEvent.setup();
    const props = makeProps({ model: "gpt-5.4-mini" });

    render(<AutomationFormView {...props} />);

    await user.click(await screen.findByRole("combobox", { name: /model/i }));
    await user.click(await screen.findByText(/use global default/i));

    expect(props.onChange).toHaveBeenCalledWith({ model: undefined });
  });

  it("shows an unavailable saved model override so it can be cleared", async () => {
    installMockAPIs({
      modelsAPI: {
        list: vi.fn<NonNullable<Window["modelsAPI"]>["list"]>().mockResolvedValue({
          success: true,
          models: [{ id: "gpt-4o", name: "GPT-4o" }],
        }),
      },
    });
    const user = userEvent.setup();
    const props = makeProps({ model: "retired-model" });

    render(<AutomationFormView {...props} />);

    const modelSelect = await screen.findByRole("combobox", { name: /model/i });
    expect(modelSelect).toHaveTextContent("retired-model (no longer available - switch to clear)");

    await user.click(modelSelect);
    expect(screen.getAllByText(/retired-model/).length).toBeGreaterThan(0);
  });
});
