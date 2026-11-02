import { describe, expect, it } from "vitest";

import { render } from "@/test-utils";

import { CardAction, CardDescription, CardFooter } from "./card";

describe("card primitives", () => {
  it.each([
    ["CardDescription", CardDescription, "text-[13px]/5 text-muted-foreground"],
    [
      "CardAction",
      CardAction,
      "col-start-2 row-span-2 row-start-1 self-start justify-self-end pt-0.5",
    ],
    [
      "CardFooter",
      CardFooter,
      "flex items-center rounded-b-xl border-t border-border/70 bg-muted/40 p-4 group-data-[size=sm]/card:p-3",
    ],
  ])("%s preserves its default class contract", (_name, Component, defaultClass) => {
    const { container } = render(<Component />);
    expect(container.firstElementChild).toHaveClass(...defaultClass.split(" "));
  });

  it.each([
    ["CardDescription", CardDescription, "text-muted-foreground"],
    ["CardAction", CardAction, "col-start-2"],
    ["CardFooter", CardFooter, "bg-muted/40"],
  ])("%s composes caller classes with caller precedence", (_name, Component, defaultClass) => {
    const { container } = render(<Component className={`${defaultClass} mt-8`} />);
    const element = container.firstElementChild;
    const classTokens = element?.className.split(/\s+/) ?? [];

    expect(element).toHaveClass(defaultClass, "mt-8");
    expect(classTokens.indexOf("mt-8")).toBeGreaterThan(classTokens.indexOf(defaultClass));
  });
});
