import type { ComponentProps, ReactNode } from "react";

import { documentPath } from "@/features/runtime-ui/documentPath";

import { isTrustedLink } from "./link-safety";

/** Keep document destinations in the DOM so the session's editor router can handle them. */
export function MarkdownLink(props: ComponentProps<"a"> | Record<string, unknown>) {
  const href = typeof props.href === "string" ? props.href : undefined;
  const className = typeof props.className === "string" ? props.className : undefined;
  // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- assertion is guarded by the surrounding logic; a typed guard is lint debt
  const children = props.children as ReactNode;
  if (!href || href === "streamdown:incomplete-link") return <span>{children}</span>;
  if (href.startsWith("#"))
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  if (!documentPath(href) && !isTrustedLink(href)) return <span>{children}</span>;
  return (
    <a
      href={href}
      className={className ?? "text-left font-medium text-primary underline"}
      data-streamdown="link"
      onClick={(event) => {
        event.preventDefault();
        // DocumentLinkScope handles local files during capture, before this callback.
        if (documentPath(href)) return;
        void window.shellAPI?.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
