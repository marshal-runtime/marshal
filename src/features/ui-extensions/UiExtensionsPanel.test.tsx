import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { Extension1PManifest } from "@/extensions";
import * as extensionsModule from "@/extensions";
import { SLOT } from "@/extensions";
import { installMockAPIs, render, screen } from "@/test-utils";

import { UiExtensionsTab } from "./UiExtensionsPanel";

// Mock extensions data access/mutations while preserving constants like SLOT/SLOT_LABEL.
vi.mock("@/extensions", async () => {
  const actual = await vi.importActual<typeof import("@/extensions")>("@/extensions");
  const extensionClient = Object.assign(
    Object.create(Object.getPrototypeOf(actual.extensionClient)),
    actual.extensionClient,
    {
      enable: vi.fn<(id: string) => void>(),
      disable: vi.fn<(id: string) => void>(),
    },
  );
  return {
    ...actual,
    useExtensions: vi.fn<() => unknown>(),
    extensionClient,
  };
});

const mockUseExtensions = vi.mocked(extensionsModule.useExtensions);
const mockExtensionClient = vi.mocked(extensionsModule.extensionClient);

function createMockManifest(overrides?: Partial<Extension1PManifest>): Extension1PManifest {
  return {
    origin: "marshal-shell",
    id: "test-extension",
    displayName: "Test Extension",
    description: "A test extension",
    contributes: {
      slots: [{ slotId: SLOT.CREATE_EDITOR }],
    },
    ...overrides,
  };
}

describe("UiExtensionsTab", () => {
  beforeEach(() => {
    installMockAPIs();
    vi.clearAllMocks();
  });

  it("renders empty state when no extensions registered", () => {
    mockUseExtensions.mockReturnValue([]);

    render(<UiExtensionsTab />);

    expect(screen.getByText("No UI plugins registered")).toBeInTheDocument();
    expect(screen.getByText("Register UI plugins in")).toBeInTheDocument();
    expect(screen.getByText("src/extensions/registered.ts")).toBeInTheDocument();
  });

  it("renders list of extensions with details", () => {
    const mockExtensions = [
      {
        manifest: createMockManifest({
          id: "extension-one",
          displayName: "Extension One",
          description: "First test extension",
          contributes: {
            slots: [{ slotId: SLOT.CREATE_EDITOR }],
          },
        }),
        enabled: true,
      },
      {
        manifest: createMockManifest({
          id: "extension-two",
          displayName: "Extension Two",
          description: "Second test extension",
          contributes: {
            slots: [
              { slotId: SLOT.CREATE_PRIMARY_SIDEBAR },
              { slotId: SLOT.CREATE_CONTENT_HEADER },
            ],
          },
        }),
        enabled: false,
      },
    ];
    mockUseExtensions.mockReturnValue(mockExtensions);

    render(<UiExtensionsTab />);

    // Check first extension
    expect(screen.getByText("Extension One")).toBeInTheDocument();
    expect(screen.getByText("extension-one")).toBeInTheDocument();
    expect(screen.getByText("First test extension")).toBeInTheDocument();
    expect(screen.getByText("Editor")).toBeInTheDocument();

    // Check second extension
    expect(screen.getByText("Extension Two")).toBeInTheDocument();
    expect(screen.getByText("extension-two")).toBeInTheDocument();
    expect(screen.getByText("Second test extension")).toBeInTheDocument();
    expect(screen.getByText("Primary Sidebar")).toBeInTheDocument();
    expect(screen.getByText("Content Header")).toBeInTheDocument();
  });

  it("handles enabling an extension", async () => {
    const user = userEvent.setup();
    const mockExtensions = [
      {
        manifest: createMockManifest({ id: "test-extension" }),
        enabled: false,
      },
    ];
    mockUseExtensions.mockReturnValue(mockExtensions);

    render(<UiExtensionsTab />);

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAttribute("aria-label", "Test Extension — enable plugin");

    await user.click(toggle);

    expect(mockExtensionClient.enable).toHaveBeenCalledWith("test-extension");
  });

  it("handles disabling an extension", async () => {
    const user = userEvent.setup();
    const mockExtensions = [
      {
        manifest: createMockManifest({ id: "test-extension" }),
        enabled: true,
      },
    ];
    mockUseExtensions.mockReturnValue(mockExtensions);

    render(<UiExtensionsTab />);

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAttribute("aria-label", "Test Extension — disable plugin");

    await user.click(toggle);

    expect(mockExtensionClient.disable).toHaveBeenCalledWith("test-extension");
  });

  it("renders multiple slot badges for extensions with multiple slots", () => {
    const mockExtensions = [
      {
        manifest: createMockManifest({
          id: "multi-slot-extension",
          displayName: "Multi Slot Extension",
          description: "Extension with multiple slots",
          contributes: {
            slots: [
              { slotId: SLOT.CREATE_PRIMARY_SIDEBAR },
              { slotId: SLOT.CREATE_EDITOR },
              { slotId: SLOT.CREATE_SECONDARY_SIDEBAR },
            ],
          },
        }),
        enabled: true,
      },
    ];
    mockUseExtensions.mockReturnValue(mockExtensions);

    render(<UiExtensionsTab />);

    expect(screen.getByText("Primary Sidebar")).toBeInTheDocument();
    expect(screen.getByText("Editor")).toBeInTheDocument();
    expect(screen.getByText("Secondary Sidebar")).toBeInTheDocument();
  });

  it("handles extensions without descriptions", () => {
    const mockExtensions = [
      {
        manifest: createMockManifest({
          id: "no-desc-extension",
          displayName: "No Description Extension",
          description: undefined,
        }),
        enabled: true,
      },
    ];
    mockUseExtensions.mockReturnValue(mockExtensions);

    render(<UiExtensionsTab />);

    expect(screen.getByText("No Description Extension")).toBeInTheDocument();
    expect(screen.queryByText("A description goes here")).not.toBeInTheDocument();
  });

  it("handles all valid slot IDs", () => {
    const mockExtensions = [
      {
        manifest: createMockManifest({
          id: "all-slots-extension",
          displayName: "All Slots Extension",
          description: "Extension using all slots",
          contributes: {
            slots: [
              { slotId: SLOT.CREATE_PRIMARY_SIDEBAR },
              { slotId: SLOT.CREATE_CONTENT_HEADER },
              { slotId: SLOT.CREATE_EDITOR },
              { slotId: SLOT.CREATE_SECONDARY_SIDEBAR },
            ],
          },
        }),
        enabled: true,
      },
    ];
    mockUseExtensions.mockReturnValue(mockExtensions);

    render(<UiExtensionsTab />);

    expect(screen.getByText("Primary Sidebar")).toBeInTheDocument();
    expect(screen.getByText("Content Header")).toBeInTheDocument();
    expect(screen.getByText("Editor")).toBeInTheDocument();
    expect(screen.getByText("Secondary Sidebar")).toBeInTheDocument();
  });
});
