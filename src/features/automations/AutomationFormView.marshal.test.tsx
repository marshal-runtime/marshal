// marshal-owned renderer test
import { beforeEach, describe, it, expect, vi } from "vitest";

import {
  createAvailableRelayProviderSettingsAPI,
  installMockAPIs,
  render,
  screen,
  userEvent,
} from "@/test-utils";

import { INITIAL_AUTOMATION_FORM_STATE, type AutomationFormState } from "./automation-form-state";
import { AutomationFormView } from "./AutomationFormView";

function makeProps(stateOverrides: Partial<AutomationFormState> = {}) {
  return {
    mode: "create" as const,
    state: { ...INITIAL_AUTOMATION_FORM_STATE, ...stateOverrides },
    onChange: vi.fn<(patch: Partial<AutomationFormState>) => void>(),
    onManagePermissions: vi.fn<() => void>(),
    onCustomizePermissions: vi.fn<() => void>(),
    onSave: vi.fn<() => void>(),
    onCancel: vi.fn<() => void>(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installMockAPIs({ relayProviderSettingsAPI: createAvailableRelayProviderSettingsAPI() });
});

describe("AutomationFormView — browserHeadless", () => {
  it("renders the 'Run browser headless' toggle", () => {
    render(<AutomationFormView {...makeProps()} />);
    expect(screen.getByLabelText(/run browser headless/i)).toBeInTheDocument();
  });

  it("renders unchecked when state.browserHeadless is false", () => {
    render(<AutomationFormView {...makeProps({ browserHeadless: false })} />);
    expect(screen.getByLabelText(/run browser headless/i)).toHaveAttribute("aria-checked", "false");
  });

  it("renders checked when state.browserHeadless is true", () => {
    render(<AutomationFormView {...makeProps({ browserHeadless: true })} />);
    expect(screen.getByLabelText(/run browser headless/i)).toHaveAttribute("aria-checked", "true");
  });

  it("emits onChange({ browserHeadless: true }) when toggled on", async () => {
    const user = userEvent.setup();
    const props = makeProps({ browserHeadless: false });
    render(<AutomationFormView {...props} />);
    await user.click(screen.getByLabelText(/run browser headless/i));
    expect(props.onChange).toHaveBeenCalledWith({ browserHeadless: true });
  });
});

describe("AutomationFormView — teamsNotify", () => {
  it("renders the relay notification selector", async () => {
    render(<AutomationFormView {...makeProps()} />);
    expect(await screen.findByTestId("relay-notify-select")).toBeInTheDocument();
  });

  it("renders 'Always' as the visible default for new automations", async () => {
    render(<AutomationFormView {...makeProps()} />);
    // shadcn Select shows the selected value's text in the trigger.
    expect(await screen.findByTestId("relay-notify-select")).toHaveTextContent(/always/i);
  });

  it("renders 'Auto' when state.teamsNotify is 'auto'", async () => {
    render(<AutomationFormView {...makeProps({ teamsNotify: "auto" })} />);
    expect(await screen.findByTestId("relay-notify-select")).toHaveTextContent(/auto/i);
  });

  it("renders 'Never' when state.teamsNotify is 'never'", async () => {
    render(<AutomationFormView {...makeProps({ teamsNotify: "never" })} />);
    expect(await screen.findByTestId("relay-notify-select")).toHaveTextContent(/never/i);
  });

  it("emits onChange({ teamsNotify: 'auto' }) when 'Auto' is selected", async () => {
    const user = userEvent.setup();
    const props = makeProps({ teamsNotify: "always" });
    render(<AutomationFormView {...props} />);
    // testId for the trigger (Radix renders it as <button>, so the implicit
    // role/name lookup is brittle); role="option" for the choice (the option
    // text "Auto" / "Never" also appears verbatim in the help-text below).
    await user.click(await screen.findByTestId("relay-notify-select"));
    await user.click(await screen.findByRole("option", { name: /auto/i }));
    expect(props.onChange).toHaveBeenCalledWith({ teamsNotify: "auto" });
  });

  it("emits onChange({ teamsNotify: 'never' }) when 'Never' is selected", async () => {
    const user = userEvent.setup();
    const props = makeProps({ teamsNotify: "always" });
    render(<AutomationFormView {...props} />);
    await user.click(await screen.findByTestId("relay-notify-select"));
    await user.click(await screen.findByRole("option", { name: /never/i }));
    expect(props.onChange).toHaveBeenCalledWith({ teamsNotify: "never" });
  });
});

describe("AutomationFormView — onChange patch contract", () => {
  it("name input renders state.name and emits { name } on input", async () => {
    const user = userEvent.setup();
    const props = makeProps({ name: "Existing" });
    render(<AutomationFormView {...props} />);
    const input = screen.getByPlaceholderText(/morning briefing/i);
    expect(input).toHaveValue("Existing");
    await user.clear(input);
    await user.type(input, "X");
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.any(String) }),
    );
  });

  it("description input emits { description } on input", async () => {
    const user = userEvent.setup();
    const props = makeProps();
    render(<AutomationFormView {...props} />);
    await user.type(screen.getByPlaceholderText(/check calendar and emails/i), "Y");
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("schedule input renders state.schedule and emits { schedule } on input", async () => {
    const user = userEvent.setup();
    const props = makeProps({ schedule: "every day at 10am" });
    render(<AutomationFormView {...props} />);
    const input = screen.getByPlaceholderText(/every weekday/i);
    expect(input).toHaveValue("every day at 10am");
    await user.type(input, "!");
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: expect.any(String) }),
    );
  });
});
