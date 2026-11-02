import type {
  RuntimeUiApplicationContent,
  RuntimeUiInstance,
  RuntimeUiJsonValue,
} from "@common/runtime-ui";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { declarativeRuntimeUiRenderer } from "./DeclarativeRuntimeUiRenderer";
import type { RuntimeUiApplicationRenderHost } from "./RuntimeUiApplicationRegistry";

const SAVE_OPERATION = "acme_connection_save_key";
const KEY_FIELD = "key";
const TYPED_KEY = "lin_api_typed";

function formDocument(eventMap?: Record<string, string>): RuntimeUiJsonValue {
  return {
    protocolVersion: "1.0.0",
    title: "Connect Linear",
    root: {
      type: "stack",
      id: "form",
      children: [
        { type: "input", id: "key-input", name: KEY_FIELD, label: "API key" },
        { type: "button", id: "save", label: "Save key", actionId: "save" },
      ],
    },
    actions: [
      {
        id: "save",
        operation: SAVE_OPERATION,
        input: { provider: "linear" },
        ...(eventMap ? { eventMap } : {}),
      },
    ],
  };
}

function instance(state: NonNullable<RuntimeUiApplicationContent["state"]>) {
  return {
    instanceId: "card-1",
    owner: {
      sessionId: "session-1",
      workspaceName: "workspace-a",
      extensionId: "@acme/marshal-runtime-extension",
      applicationId: "connect-linear",
    },
    surface: "inline-card",
    content: {
      kind: "application",
      renderId: "acme.connections.v1",
      resource: { uri: "acme-runtime://connections/linear", mimeType: "text/plain" },
      descriptor: { version: "1.0.0", presentationModes: ["inline"], actions: [], tools: [] },
      state,
    },
    idempotencyKey: "connect-linear:1",
    revision: 1,
    openedAt: "2026-09-07T12:00:00.000Z",
    updatedAt: "2026-09-07T12:00:01.000Z",
    focusedAt: "2026-09-07T12:00:01.000Z",
  } satisfies RuntimeUiInstance;
}

function makeHost(document: ReturnType<typeof formDocument>) {
  const invokeCapability = vi.fn<RuntimeUiApplicationRenderHost["invokeCapability"]>(async () => ({
    output: { status: "connected" },
  }));
  const host: RuntimeUiApplicationRenderHost = {
    instance: instance({ document }),
    editor: { id: "test-editor", SourceEditor: () => null },
    invokeCapability,
    readResource: async () => {
      throw new Error("not used by declarative renderer");
    },
    subscribe: () => () => undefined,
    focus: async () => undefined,
    close: async () => undefined,
    update: async () => undefined,
  };
  return { host, invokeCapability };
}

describe("Declarative runtime UI form submission", () => {
  it("merges typed input values into the action input through eventMap", async () => {
    const user = userEvent.setup();
    const document = formDocument({ [KEY_FIELD]: KEY_FIELD });
    const { host, invokeCapability } = makeHost(document);
    render(<>{declarativeRuntimeUiRenderer({ instance: host.instance, host })}</>);
    await user.type(screen.getByLabelText("API key"), TYPED_KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(invokeCapability).toHaveBeenCalled());
    expect(invokeCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: SAVE_OPERATION,
        input: { provider: "linear", [KEY_FIELD]: TYPED_KEY },
      }),
    );
  });
  it("sends only static inputs when the action declares no eventMap", async () => {
    const user = userEvent.setup();
    const { host, invokeCapability } = makeHost(formDocument());
    render(<>{declarativeRuntimeUiRenderer({ instance: host.instance, host })}</>);
    await user.type(screen.getByLabelText("API key"), TYPED_KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(invokeCapability).toHaveBeenCalled());
    expect(invokeCapability).toHaveBeenCalledWith(
      expect.objectContaining({ input: { provider: "linear" } }),
    );
  });
  it("omits eventMap fields the user never typed", async () => {
    const user = userEvent.setup();
    const { host, invokeCapability } = makeHost(formDocument({ [KEY_FIELD]: KEY_FIELD }));
    render(<>{declarativeRuntimeUiRenderer({ instance: host.instance, host })}</>);
    await user.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(invokeCapability).toHaveBeenCalled());
    expect(invokeCapability).toHaveBeenCalledWith(
      expect.objectContaining({ input: { provider: "linear" } }),
    );
  });
});
