import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";
import type { McpServerInfo } from "@common/marshal-ipc-contract";
import { MCP_ENV_DIR_TOKEN } from "@common/marshal-mcp-env-file";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Tabs } from "@/components/marshal-ui/marshal-tabs";
import { installMockAPIs, render, screen, userEvent } from "@/test-utils";

import { McpServersTab } from "./McpServersTab";

const installedCatalogServer: CatalogItem = {
  id: "example-tracker",
  name: "example-tracker",
  displayName: "Example Tracker",
  description: "Already-installed MCP server",
  icon: "🔌",
  author: "Example",
  type: "mcp-servers",
  tags: [],
  source: { type: "bundled" },
};

const defaultProps = {
  filteredCatalogMcpServers: [],
  filteredMcpServers: [],
  search: "",
  getInstallState: () => "available" as const,
  onInstallCatalogItem: vi.fn<() => void>(),
  onSelectCatalogItem: vi.fn<() => void>(),
  onSelectCustomServer: vi.fn<() => void>(),
  addingMcp: false,
  onAddMcpOpen: vi.fn<() => void>(),
  newMcpName: "",
  newMcpUrl: "",
  newMcpCommand: "",
  newMcpBearerToken: "",
  newMcpTimeoutSeconds: "",
  newMcpEnvFile: "",
  newMcpMode: "url" as const,
  newMcpTransport: "http" as const,
  onNameChange: vi.fn<() => void>(),
  onUrlChange: vi.fn<() => void>(),
  onCommandChange: vi.fn<() => void>(),
  onBearerTokenChange: vi.fn<() => void>(),
  onTimeoutSecondsChange: vi.fn<() => void>(),
  onEnvFileChange: vi.fn<() => void>(),
  onModeChange: vi.fn<() => void>(),
  onTransportChange: vi.fn<() => void>(),
  onAddMcpSave: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  onAddMcpClose: vi.fn<() => void>(),
};

function renderMcpServersTab(overrides?: Partial<React.ComponentProps<typeof McpServersTab>>) {
  return render(
    <Tabs defaultValue="mcp-servers">
      <McpServersTab {...defaultProps} {...overrides} />
    </Tabs>,
  );
}

describe("McpServersTab", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("opens the catalog detail dialog when 'Use' is clicked on an already-installed MCP server (regression)", async () => {
    const user = userEvent.setup();
    const onSelectCatalogItem = vi.fn<() => void>();
    const onInstallCatalogItem = vi.fn<() => void>();
    renderMcpServersTab({
      filteredCatalogMcpServers: [installedCatalogServer],
      getInstallState: () => "installed",
      onSelectCatalogItem,
      onInstallCatalogItem,
    });

    await user.click(screen.getByRole("button", { name: /^Use$/ }));

    expect(onSelectCatalogItem).toHaveBeenCalledWith(installedCatalogServer);
    expect(onInstallCatalogItem).not.toHaveBeenCalled();
  });

  describe("KeyRound (Edit env file) button", () => {
    function makeStdioServer(envFile: string | undefined): McpServerInfo {
      return {
        key: "my-server",
        name: "my-server",
        builtin: false,
        config: { name: "my-server", type: "command", command: "node", envFile },
        status: "connected",
      };
    }

    it("renders for envFile under ${mcpEnvDir}/<key>.env and invokes openEnvFile with that key", async () => {
      const user = userEvent.setup();
      renderMcpServersTab({
        filteredMcpServers: [makeStdioServer(`${MCP_ENV_DIR_TOKEN}/my-server.env`)],
      });

      const btn = await screen.findByRole("button", { name: /edit env file/i });
      await user.click(btn);

      expect(window.mcpsAPI.openEnvFile).toHaveBeenCalledWith("my-server", "default");
    });

    it("does not render for envFile pointing at ${workspaceFolder}/.env", () => {
      renderMcpServersTab({
        filteredMcpServers: [makeStdioServer("${workspaceFolder}/.env")],
      });

      expect(screen.queryByRole("button", { name: /edit env file/i })).not.toBeInTheDocument();
    });

    it("does not render for envFile pointing at an absolute path outside the managed dir", () => {
      renderMcpServersTab({
        filteredMcpServers: [makeStdioServer("/Users/me/secrets/.env")],
      });

      expect(screen.queryByRole("button", { name: /edit env file/i })).not.toBeInTheDocument();
    });

    it("does not render when envFile is undefined", () => {
      renderMcpServersTab({
        filteredMcpServers: [makeStdioServer(undefined)],
      });

      expect(screen.queryByRole("button", { name: /edit env file/i })).not.toBeInTheDocument();
    });
  });
});
