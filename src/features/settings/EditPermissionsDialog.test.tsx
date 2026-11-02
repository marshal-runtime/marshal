import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, userEvent } from "@/test-utils";
import type { PermissionsConfig } from "@/types/electron";

import { EditPermissionsDialog } from "./permissions/EditPermissionsDialog";

beforeEach(() => {
  installMockAPIs();
});

const defaultPermissions = {
  autoApproveReadOnly: false,
  allow: ["npm run *"],
  tools: {},
  servers: {
    filesystem: { enabled: true, autoApprove: true },
  },
};

function renderDialog(overrides: { open?: boolean } = {}) {
  const onSave = vi.fn<(p: PermissionsConfig) => void>();
  const onOpenChange = vi.fn<(open: boolean) => void>();
  render(
    <EditPermissionsDialog
      open={overrides.open ?? true}
      onOpenChange={onOpenChange}
      permissions={defaultPermissions}
      onSave={onSave}
    />,
  );
  return { onSave, onOpenChange };
}

describe("EditPermissionsDialog", () => {
  it("renders JSON content when open", () => {
    renderDialog();
    expect(screen.getByText("Edit Permissions")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue(JSON.stringify(defaultPermissions, null, 2));
  });

  it("saves valid JSON and closes", async () => {
    const user = userEvent.setup();
    const { onSave, onOpenChange } = renderDialog();

    // The textarea already has valid JSON from the permissions prop.
    // Just click Save to verify it parses and calls onSave.
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(defaultPermissions);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each(["{}", '{"autopilotMode":true}'])(
    "saves valid partial permissions JSON: %s",
    async (value) => {
      const user = userEvent.setup();
      const { onSave, onOpenChange } = renderDialog();
      const textarea = screen.getByRole("textbox");
      await user.clear(textarea);
      await user.paste(value);
      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(onSave).toHaveBeenCalledWith(JSON.parse(value));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
  );

  it("shows error for invalid JSON and does not save", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "not json");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText(/Invalid JSON/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows error when JSON is not an object", async () => {
    const user = userEvent.setup();
    const { onSave } = renderDialog();

    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, '"just a string"');
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText(/Expected an object/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each(["[]", '{"allow":"npm *"}', '{"allow":[],"tools":[],"servers":{}}'])(
    "rejects malformed permissions JSON: %s",
    async (value) => {
      const user = userEvent.setup();
      const { onSave } = renderDialog();
      const textarea = screen.getByRole("textbox");
      await user.clear(textarea);
      await user.paste(value);
      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(screen.getByText(/Invalid JSON/)).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    },
  );

  it("cancel closes without saving", async () => {
    const user = userEvent.setup();
    const { onSave, onOpenChange } = renderDialog();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
