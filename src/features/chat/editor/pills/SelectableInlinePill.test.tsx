import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InlinePillDecorator } from "./SelectableInlinePill";
import { subtleSelectionStyle } from "./SelectableInlinePill.styles";

vi.mock("@lexical/react/LexicalComposerContext", () => ({
  useLexicalComposerContext: () => [{ registerCommand: vi.fn<() => () => void>(() => () => {}) }],
}));
vi.mock("@lexical/react/useLexicalNodeSelection", () => ({
  useLexicalNodeSelection: () => [true, vi.fn<() => void>(), vi.fn<() => void>()],
}));
vi.mock("@lexical/utils", () => ({
  mergeRegister:
    (...cleanups: Array<() => void>) =>
    () => {
      cleanups.forEach((cleanup) => cleanup());
    },
}));

describe("InlinePillDecorator selection contract", () => {
  it("keeps selectedClassName empty string as selected-style suppression", () => {
    render(
      <InlinePillDecorator nodeKey="pill" selectedClassName="">
        pill
      </InlinePillDecorator>,
    );
    // oxlint-disable-next-line testing-library/no-node-access
    const element = screen.getByText("pill").parentElement;

    expect(element?.getAttribute("style")).toBeNull();
  });

  it("applies subtle selection without a padding or layout delta", () => {
    const backgroundColorSpy = vi.spyOn(CSSStyleDeclaration.prototype, "backgroundColor", "set");
    const borderRadiusSpy = vi.spyOn(CSSStyleDeclaration.prototype, "borderRadius", "set");
    const boxShadowSpy = vi.spyOn(CSSStyleDeclaration.prototype, "boxShadow", "set");
    const paddingSpy = vi.spyOn(CSSStyleDeclaration.prototype, "padding", "set");
    const displaySpy = vi.spyOn(CSSStyleDeclaration.prototype, "display", "set");
    const widthSpy = vi.spyOn(CSSStyleDeclaration.prototype, "width", "set");
    const fontSpy = vi.spyOn(CSSStyleDeclaration.prototype, "font", "set");

    render(
      <InlinePillDecorator
        nodeKey="pill"
        className="font-semibold"
        selectedClassName=""
        selectionTreatment="subtle"
      >
        pill
      </InlinePillDecorator>,
    );
    // oxlint-disable-next-line testing-library/no-node-access
    const element = screen.getByText("pill").parentElement;

    expect(backgroundColorSpy).toHaveBeenCalledWith(subtleSelectionStyle.backgroundColor);
    expect(borderRadiusSpy).toHaveBeenCalledWith(subtleSelectionStyle.borderRadius);
    expect(boxShadowSpy).toHaveBeenCalledWith(subtleSelectionStyle.boxShadow);
    expect(paddingSpy).not.toHaveBeenCalled();
    expect(displaySpy).not.toHaveBeenCalled();
    expect(widthSpy).not.toHaveBeenCalled();
    expect(fontSpy).not.toHaveBeenCalled();

    expect(element).toBeTruthy();
    vi.restoreAllMocks();
  });
});
