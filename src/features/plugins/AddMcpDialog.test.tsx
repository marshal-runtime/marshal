import type { McpsAPI } from "@common/marshal-ipc-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen, userEvent, waitFor } from "@/test-utils";

import { AddMcpDialog } from "./AddMcpDialog";

function renderDialog(overrides?: Partial<React.ComponentProps<typeof AddMcpDialog>>) {
  const props: React.ComponentProps<typeof AddMcpDialog> = {
    name: "Demo",
    url: "",
    command: "npx -y demo-mcp",
    bearerToken: "",
    timeoutSeconds: "",
    envFile: "",
    mode: "command",
    transport: "http",
    onNameChange: vi.fn<() => void>(),
    onUrlChange: vi.fn<() => void>(),
    onCommandChange: vi.fn<() => void>(),
    onBearerTokenChange: vi.fn<() => void>(),
    onTimeoutSecondsChange: vi.fn<() => void>(),
    onEnvFileChange: vi.fn<() => void>(),
    onModeChange: vi.fn<() => void>(),
    onTransportChange: vi.fn<() => void>(),
    onSave: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onClose: vi.fn<() => void>(),
    canSave: true,
    ...overrides,
  };

  return { ...render(<AddMcpDialog {...props} />), props };
}

describe("AddMcpDialog secrets file", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("pre-fills the path input placeholder with the ${mcpEnvDir} default derived from the server name", async () => {
    const user = userEvent.setup();

    renderDialog();

    await user.click(screen.getByRole("button", { name: /Environment variables/ }));

    // The default is shown as the placeholder until the user types — Marshal
    // never auto-pushes derived state back to the parent on each keystroke.
    const input = await screen.findByPlaceholderText("${mcpEnvDir}/demo.env");
    expect(input).toHaveValue("");
  });

  it("opens the file via mcpsAPI.openEnvFile and commits the default path to the parent on first use", async () => {
    const user = userEvent.setup();
    const onEnvFileChange = vi.fn<() => void>();
    window.mcpsAPI.openEnvFile = vi
      .fn<McpsAPI["openEnvFile"]>()
      .mockResolvedValue({ success: true });

    renderDialog({ onEnvFileChange });

    await user.click(screen.getByRole("button", { name: /Environment variables/ }));
    await user.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(window.mcpsAPI.openEnvFile).toHaveBeenCalledWith("demo", "default"));
    expect(onEnvFileChange).toHaveBeenCalledWith("${mcpEnvDir}/demo.env");
  });

  it("reveals the file in the OS file manager", async () => {
    const user = userEvent.setup();
    window.mcpsAPI.openEnvFile = vi
      .fn<McpsAPI["openEnvFile"]>()
      .mockResolvedValue({ success: true, revealed: true });

    renderDialog();

    await user.click(screen.getByRole("button", { name: /Environment variables/ }));
    await user.click(screen.getByRole("button", { name: "Reveal" }));

    await waitFor(() => expect(window.mcpsAPI.openEnvFile).toHaveBeenCalledWith("demo", "reveal"));
  });

  it("hides the open/reveal actions for custom paths (only ${mcpEnvDir}/<name>.env is supported)", async () => {
    const user = userEvent.setup();

    renderDialog({ envFile: "${workspaceFolder}/.env" });

    await user.click(screen.getByRole("button", { name: /Environment variables/ }));

    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal" })).not.toBeInTheDocument();
    expect(screen.getByText(/Open\/Reveal shortcuts work only for/)).toBeInTheDocument();
  });
});

describe("AddMcpDialog command warning", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("shows a local command warning when command mode is selected", () => {
    renderDialog({ mode: "command" });

    expect(screen.getByText("Local command warning")).toBeInTheDocument();
    expect(
      screen.getByText(/Command MCP servers run a local process on your computer/i),
    ).toBeInTheDocument();
  });

  it("does not show the local command warning for URL mode", () => {
    renderDialog({ mode: "url", command: "", url: "https://mcp.example.com" });

    expect(screen.queryByText("Local command warning")).not.toBeInTheDocument();
  });
});
