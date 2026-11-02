import { useMemo } from "react";

import { MarkdownRenderer } from "@/plugins/streamdown-config";

import { RuntimeUiMessageSlot } from "./ConversationCards";
import { splitMessageSlots } from "./messageSlots";

/**
 * Message markdown with inline UI slots: each `<!--ui:name-->` line becomes
 * the view the agent bound to that slot. Messages without slots render
 * exactly as plain markdown.
 */
export function MessageMarkdown({
  children,
  live = false,
}: {
  readonly children: string;
  readonly live?: boolean;
}) {
  const segments = useMemo(() => splitMessageSlots(children), [children]);
  if (segments.length === 1 && segments[0].kind === "markdown") {
    return <MarkdownRenderer>{children}</MarkdownRenderer>;
  }
  return (
    <>
      {segments.map((segment) =>
        segment.kind === "slot" ? (
          <RuntimeUiMessageSlot key={segment.key} name={segment.name} live={live} />
        ) : (
          <MarkdownRenderer key={segment.key}>{segment.text}</MarkdownRenderer>
        ),
      )}
    </>
  );
}
