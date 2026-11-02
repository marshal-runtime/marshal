import * as React from "react";
import { describe, expect, it } from "vitest";

import { render, screen } from "@/test-utils";

import { Badge } from "./badge";
import { Input } from "./input";
import { Label } from "./label";
import { Textarea } from "./textarea";

describe("form primitives", () => {
  it("preserves Input defaults, prop precedence, ref forwarding, and class merging", () => {
    const ref = React.createRef<HTMLInputElement>();
    render(
      <>
        <Input data-testid="default-input" />
        <Input
          ref={ref}
          data-testid="custom-input"
          data-slot="custom-input"
          aria-label="Account"
          name="account"
          className="opacity-50"
        />
      </>,
    );

    const defaultInput = screen.getByTestId("default-input");
    const input = screen.getByTestId("custom-input");
    expect(defaultInput).not.toHaveAttribute("type");
    expect(defaultInput).toHaveAttribute("data-slot", "input");
    expect(defaultInput).toHaveClass("h-8");
    expect(input).toBe(ref.current);
    expect(input).not.toHaveAttribute("type");
    expect(input).toHaveAttribute("data-slot", "custom-input");
    expect(input).toHaveAttribute("aria-label", "Account");
    expect(input).toHaveAttribute("name", "account");
    expect(input).toHaveClass("h-8", "opacity-50");
  });

  it("preserves Label prop precedence, ref forwarding, and class merging", () => {
    const ref = React.createRef<HTMLLabelElement>();
    render(
      <>
        <Label data-testid="default-label">Default</Label>
        <Label
          ref={ref}
          data-testid="custom-label"
          data-slot="custom-label"
          htmlFor="account"
          title="Account label"
          className="opacity-50"
        >
          Account
        </Label>
      </>,
    );

    const defaultLabel = screen.getByTestId("default-label");
    const label = screen.getByTestId("custom-label");
    expect(defaultLabel).toHaveAttribute("data-slot", "label");
    expect(defaultLabel).toHaveClass("flex");
    expect(label).toBe(ref.current);
    expect(label).toHaveAttribute("data-slot", "custom-label");
    expect(label).toHaveAttribute("for", "account");
    expect(label).toHaveAttribute("title", "Account label");
    expect(label).toHaveClass("flex", "opacity-50");
  });

  it("preserves Textarea prop precedence, ref forwarding, and class merging", () => {
    const ref = React.createRef<HTMLTextAreaElement>();
    render(
      <>
        <Textarea data-testid="default-textarea" />
        <Textarea
          ref={ref}
          data-testid="custom-textarea"
          data-slot="custom-textarea"
          aria-label="Description"
          name="description"
          rows={4}
          className="opacity-50"
        />
      </>,
    );

    const defaultTextarea = screen.getByTestId("default-textarea");
    const textarea = screen.getByTestId("custom-textarea");
    expect(defaultTextarea).toHaveAttribute("data-slot", "textarea");
    expect(defaultTextarea).toHaveClass("min-h-16");
    expect(textarea).toBe(ref.current);
    expect(textarea).toHaveAttribute("data-slot", "custom-textarea");
    expect(textarea).toHaveAttribute("aria-label", "Description");
    expect(textarea).toHaveAttribute("name", "description");
    expect(textarea).toHaveAttribute("rows", "4");
    expect(textarea).toHaveClass("min-h-16", "opacity-50");
  });

  it("preserves Badge defaults, prop precedence, ref forwarding, and class merging", () => {
    const ref = React.createRef<HTMLSpanElement>();
    render(
      <>
        <Badge data-testid="default-badge">Default</Badge>
        <Badge
          ref={ref}
          data-testid="custom-badge"
          data-slot="custom-badge"
          data-variant="custom-variant"
          title="Status"
          className="opacity-50"
        >
          Ready
        </Badge>
      </>,
    );

    const defaultBadge = screen.getByTestId("default-badge");
    const badge = screen.getByTestId("custom-badge");
    expect(defaultBadge).toHaveAttribute("data-slot", "badge");
    expect(defaultBadge).toHaveAttribute("data-variant", "default");
    expect(defaultBadge).toHaveClass("h-5", "bg-primary");
    expect(defaultBadge?.className).not.toContain("--badge-bg");
    expect(badge).toBe(ref.current);
    expect(badge).toHaveAttribute("data-slot", "custom-badge");
    expect(badge).toHaveAttribute("data-variant", "custom-variant");
    expect(badge).toHaveAttribute("title", "Status");
    expect(badge).toHaveClass("h-5", "bg-primary", "opacity-50");
  });
});
