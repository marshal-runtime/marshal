import type { RuntimeExtensionsStatusSnapshot } from "@common/marshal-ipc-contract";
import type { RuntimeExtensionCatalogEntry } from "@marshal/runtime/extensions";
import { describe, expect, it, vi } from "vitest";

import { render, screen, userEvent } from "@/test-utils";

import { RuntimeExtensionsSection } from "./RuntimeExtensionsSection";

const INTEGRITY = {
  algorithm: "sha256" as const,
  domain: "marshal-runtime-extension-package-v1" as const,
  value: "a".repeat(64),
};

function runtimeEntry({
  id,
  title,
  installationStatus,
  health,
  configuration,
}: {
  id: string;
  title: string;
  installationStatus: "enabled" | "disabled";
  health?: RuntimeExtensionCatalogEntry["health"];
  configuration?: Readonly<Record<string, unknown>>;
}): RuntimeExtensionCatalogEntry {
  return {
    id,
    identity: `@fixture/${id}`,
    version: "1.0.0",
    origin: "native",
    originLabel: "Native",
    title,
    description: `${title} description`,
    sourceId: "native",
    sourceLabel: "Native",
    sourceOrder: 0,
    order: 0,
    request: {
      packageRoot: `C:\\runtime-extensions\\${id}`,
      integrity: INTEGRITY,
    },
    installation: {
      identity: `@fixture/${id}`,
      version: "1.0.0",
      integrity: INTEGRITY,
      entrypoint: "dist/index.cjs",
      status: installationStatus,
      activationOrder: 1,
      configuration: configuration ?? {},
    },
    isCurrentVersion: true,
    health,
  };
}

function statusSnapshot(
  items: RuntimeExtensionsStatusSnapshot["items"],
  diagnostics: RuntimeExtensionsStatusSnapshot["diagnostics"] = [],
): RuntimeExtensionsStatusSnapshot {
  return {
    sessionId: "session-1",
    workspaceName: "workspace-1",
    revision: 1,
    scannedAt: "2026-08-29T00:00:00.000Z",
    discoveryStatus: "ready",
    items,
    diagnostics,
  };
}

function mountSection({
  entries = [],
  status,
}: {
  entries?: readonly RuntimeExtensionCatalogEntry[];
  status?: RuntimeExtensionsStatusSnapshot;
}) {
  const actions = {
    onInstall: vi.fn<(entry: RuntimeExtensionCatalogEntry) => void>(),
    onInstallDetected: vi.fn<(packageRoot: string) => void>(),
    onUpdate: vi.fn<(entry: RuntimeExtensionCatalogEntry) => void>(),
    onUpdateFromDirectory: vi.fn<(entry: RuntimeExtensionCatalogEntry) => void>(),
    onEnable: vi.fn<(entry: RuntimeExtensionCatalogEntry) => void>(),
    onDisable: vi.fn<(entry: RuntimeExtensionCatalogEntry) => void>(),
    onRemove: vi.fn<(entry: RuntimeExtensionCatalogEntry) => void>(),
    onConfigure:
      vi.fn<
        (
          entry: RuntimeExtensionCatalogEntry,
          configuration: Readonly<Record<string, unknown>>,
        ) => void
      >(),
  };
  render(
    <RuntimeExtensionsSection entries={entries} status={status} pending={false} {...actions} />,
  );
  return actions;
}

describe("RuntimeExtensionsSection", () => {
  it("offers an update for an existing installation instead of a fresh install", async () => {
    const entry = {
      ...runtimeEntry({ id: "update", title: "Browser", installationStatus: "enabled" }),
      isCurrentVersion: false,
      version: "2.0.0",
    };
    const actions = mountSection({ entries: [entry] });
    expect(screen.queryByRole("button", { name: /^Install$/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /^Update$/ }));
    expect(actions.onUpdate).toHaveBeenCalledWith(entry);
  });

  it("renders detected, invalid, unbuilt, and installing packages with diagnostics and build details", async () => {
    const detectedRoot = "C:\\runtime-extensions\\detected";
    const unbuiltRoot = "C:\\runtime-extensions\\unbuilt";
    const handlers = mountSection({
      status: statusSnapshot(
        [
          {
            candidateId: detectedRoot,
            identity: "@fixture/detected",
            packageRoot: detectedRoot,
            status: "detected",
            diagnostics: [],
          },
          {
            candidateId: unbuiltRoot,
            identity: "@fixture/unbuilt",
            version: "1.0.0",
            packageRoot: unbuiltRoot,
            status: "unbuilt",
            installation: { script: "install:marshal", packageManager: "pnpm" },
            diagnostics: [
              {
                code: "entrypoint_missing",
                path: `${unbuiltRoot}\\dist\\index.cjs`,
                message: "Runtime extension entrypoint has not been built.",
              },
            ],
          },
          {
            candidateId: "C:\\runtime-extensions\\invalid",
            identity: "@fixture/invalid",
            status: "invalid",
            diagnostics: [],
          },
          {
            candidateId: "C:\\runtime-extensions\\installing",
            identity: "@fixture/installing",
            status: "installing",
            diagnostics: [],
          },
        ],
        [
          {
            code: "scan_warning",
            path: "C:\\runtime-extensions",
            message: "One package could not be scanned.",
          },
        ],
      ),
    });
    const user = userEvent.setup();

    expect(screen.getByText("Detected")).not.toBeNull();
    expect(screen.getByText("Build required")).not.toBeNull();
    expect(screen.getByText("Invalid")).not.toBeNull();
    expect(screen.getByText("Installing / building")).not.toBeNull();
    expect(screen.getByText(unbuiltRoot, { selector: "dd" })).not.toBeNull();
    expect(screen.getByText("pnpm", { selector: "dd" })).not.toBeNull();
    expect(screen.getByText("pnpm run install:marshal")).not.toBeNull();
    expect(screen.getByText("Runtime extension entrypoint has not been built.")).not.toBeNull();
    expect(screen.getByText(`entrypoint_missing - ${unbuiltRoot}\\dist\\index.cjs`)).not.toBeNull();
    expect(screen.getByText("One package could not be scanned.")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Install" }));
    await user.click(screen.getByRole("button", { name: "Install and build" }));

    expect(handlers.onInstallDetected).toHaveBeenNthCalledWith(1, detectedRoot);
    expect(handlers.onInstallDetected).toHaveBeenNthCalledWith(2, unbuiltRoot);
  });

  it("renders installed, blocked, and failed states with lifecycle and configuration actions", async () => {
    const enabled = runtimeEntry({
      id: "enabled",
      title: "Enabled Runtime",
      installationStatus: "enabled",
      configuration: { region: "west" },
    });
    const disabled = runtimeEntry({
      id: "disabled",
      title: "Disabled Runtime",
      installationStatus: "disabled",
    });
    const blocked = runtimeEntry({
      id: "blocked",
      title: "Blocked Runtime",
      installationStatus: "enabled",
      health: "blocked",
    });
    const failed = runtimeEntry({
      id: "failed",
      title: "Failed Runtime",
      installationStatus: "enabled",
    });
    const entries = [enabled, disabled, blocked, failed];
    const handlers = mountSection({
      entries,
      status: statusSnapshot(
        entries.map((entry) => ({
          candidateId: entry.id,
          catalogEntryId: entry.id,
          identity: entry.identity,
          packageRoot: `C:\\runtime-extensions\\${entry.id}`,
          status:
            entry.id === "failed"
              ? "unreadable"
              : entry.installation?.status === "disabled"
                ? "installed-disabled"
                : "installed-enabled",
          diagnostics: [],
        })),
      ),
    });
    const user = userEvent.setup();

    expect(screen.getByText("Installed and enabled")).not.toBeNull();
    expect(screen.getByText("Installed and disabled")).not.toBeNull();
    expect(screen.getByText("Blocked")).not.toBeNull();
    expect(screen.getByText("Failed")).not.toBeNull();
    expect(screen.getByText('Current values: {"region":"west"}')).not.toBeNull();

    await user.click(screen.getAllByRole("button", { name: "Disable" })[0]);
    await user.click(screen.getByRole("button", { name: "Enable" }));
    expect(handlers.onDisable).toHaveBeenCalledWith(enabled);
    expect(handlers.onEnable).toHaveBeenCalledWith(disabled);

    await user.click(screen.getAllByRole("button", { name: "Remove" })[3]);
    expect(handlers.onRemove).toHaveBeenCalledWith(failed);

    const configuration = screen.getByLabelText("Configuration for Enabled Runtime");
    await user.clear(configuration);
    await user.paste('{"region":"east"}');
    await user.click(screen.getAllByRole("button", { name: "Configure" })[0]);
    expect(handlers.onConfigure).toHaveBeenCalledWith(enabled, { region: "east" });
  });
});
