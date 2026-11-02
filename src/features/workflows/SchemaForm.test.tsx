// src/features/workflows/SchemaForm.test.tsx
//
// Renders SchemaForm against several JSON-schema fixtures and verifies
// that submit captures the structured value.

import type { WorkflowJSONSchema } from "@common/workflows-contract";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import { TooltipProvider } from "@/components/marshal-ui/marshal-tooltip";

import { SchemaForm } from "./SchemaForm";

function Wrap({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

describe("SchemaForm", () => {
  test("renders text input and submits the value", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: unknown) => void>();
    const schema: WorkflowJSONSchema = {
      type: "object",
      properties: {
        name: { type: "string", description: "Your name" },
      },
      required: ["name"],
    };
    render(
      <Wrap>
        <SchemaForm schema={schema} onSubmit={onSubmit} />
      </Wrap>,
    );
    const input = screen.getByLabelText(/name/i);
    await user.type(input, "Alice");
    await user.click(screen.getByRole("button", { name: /run/i }));
    expect(onSubmit).toHaveBeenCalledWith({ name: "Alice" });
  });

  test("renders boolean as switch", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: unknown) => void>();
    const schema: WorkflowJSONSchema = {
      type: "object",
      properties: { enabled: { type: "boolean" } },
    };
    render(
      <Wrap>
        <SchemaForm schema={schema} onSubmit={onSubmit} />
      </Wrap>,
    );
    const sw = screen.getByRole("switch", { name: /enabled/i });
    await user.click(sw);
    await user.click(screen.getByRole("button", { name: /run/i }));
    expect(onSubmit).toHaveBeenCalledWith({ enabled: true });
  });

  test("uses default values from schema", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: unknown) => void>();
    const schema: WorkflowJSONSchema = {
      type: "object",
      properties: {
        count: { type: "number", default: 5 },
      },
    };
    render(
      <Wrap>
        <SchemaForm schema={schema} onSubmit={onSubmit} />
      </Wrap>,
    );
    await user.click(screen.getByRole("button", { name: /run/i }));
    expect(onSubmit).toHaveBeenCalledWith({ count: 5 });
  });

  test("renders array of strings as comma-separated input", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(value: unknown) => void>();
    const schema: WorkflowJSONSchema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
      },
    };
    render(
      <Wrap>
        <SchemaForm schema={schema} onSubmit={onSubmit} />
      </Wrap>,
    );
    const input = screen.getByLabelText(/tags/i);
    // Paste so the full string lands in one onChange — typing character by
    // character would strip the trailing empty fragment after each comma.
    await user.click(input);
    await user.paste("a, b, c");
    await user.click(screen.getByRole("button", { name: /run/i }));
    expect(onSubmit).toHaveBeenCalledWith({ tags: ["a", "b", "c"] });
  });

  test("cancel button calls onCancel when present", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn<() => void>();
    render(
      <Wrap>
        <SchemaForm
          schema={{ type: "object", properties: { x: { type: "string" } } }}
          onSubmit={vi.fn<(value: unknown) => void>()}
          onCancel={onCancel}
        />
      </Wrap>,
    );
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
