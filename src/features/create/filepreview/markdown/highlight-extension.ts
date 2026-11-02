/**
 * Micromark + mdast-util extensions for ==highlight== syntax.
 *
 * Follows the same pattern as micromark-extension-gfm-strikethrough:
 * a sequence of `=` characters that opens/closes an attention-like construct.
 * The mdast node type is "highlight" with a children array.
 */

import type { Nodes, Parent } from "mdast";
import type { CompileContext, Extension as FromMdExtension } from "mdast-util-from-markdown";
import { splice } from "micromark-util-chunked";
import { classifyCharacter } from "micromark-util-classify-character";
import { resolveAll } from "micromark-util-resolve-all";
import { codes, constants, types } from "micromark-util-symbol";
import type {
  Event,
  Extension,
  Resolver,
  State,
  TokenizeContext,
  Tokenizer,
} from "micromark-util-types";

// ── Augment micromark token type map for custom tokens ─────────
declare module "micromark-util-types" {
  interface TokenTypeMap {
    highlight: "highlight";
    highlightSequence: "highlightSequence";
    highlightSequenceTemporary: "highlightSequenceTemporary";
    highlightText: "highlightText";
  }
}

// ── mdast node type ────────────────────────────────────────────
export interface Highlight extends Parent {
  type: "highlight";
  children: import("mdast").PhrasingContent[];
}

declare module "mdast" {
  interface PhrasingContentMap {
    highlight: Highlight;
  }
  interface RootContentMap {
    highlight: Highlight;
  }
}

// ── micromark extension ────────────────────────────────────────

/** Create a micromark extension to enable ==highlight== syntax. */
export function highlight(): Extension {
  const tokenizer = {
    name: "highlight",
    tokenize: tokenizeHighlightSyntax,
    resolveAll: resolveHighlightEvents,
  };

  return {
    text: { [codes.equalsTo]: tokenizer },
    insideSpan: { null: [tokenizer] },
    attentionMarkers: { null: [codes.equalsTo] },
  };
}

const resolveHighlightEvents: Resolver = function resolveHighlightEvents(events, context) {
  let index = -1;

  while (++index < events.length) {
    if (
      events[index][0] === "enter" &&
      events[index][1].type === "highlightSequenceTemporary" &&
      events[index][1]._close
    ) {
      let open = index;

      while (open--) {
        if (
          events[open][0] === "exit" &&
          events[open][1].type === "highlightSequenceTemporary" &&
          events[open][1]._open &&
          events[index][1].end.offset - events[index][1].start.offset ===
            events[open][1].end.offset - events[open][1].start.offset
        ) {
          events[index][1].type = "highlightSequence";
          events[open][1].type = "highlightSequence";

          const mark = {
            type: "highlight" as const,
            start: Object.assign({}, events[open][1].start),
            end: Object.assign({}, events[index][1].end),
          };

          const text = {
            type: "highlightText" as const,
            start: Object.assign({}, events[open][1].end),
            end: Object.assign({}, events[index][1].start),
          };

          const nextEvents: Array<Event> = [
            ["enter", mark, context],
            ["enter", events[open][1], context],
            ["exit", events[open][1], context],
            ["enter", text, context],
          ];

          const insideSpan = context.parser.constructs.insideSpan.null;
          if (insideSpan) {
            splice(
              nextEvents,
              nextEvents.length,
              0,
              resolveAll(insideSpan, events.slice(open + 1, index), context),
            );
          }

          splice(nextEvents, nextEvents.length, 0, [
            ["exit", text, context],
            ["enter", events[index][1], context],
            ["exit", events[index][1], context],
            ["exit", mark, context],
          ]);

          splice(events, open - 1, index - open + 3, nextEvents);
          index = open + nextEvents.length - 2;
          break;
        }
      }
    }
  }

  index = -1;
  while (++index < events.length) {
    if (events[index][1].type === "highlightSequenceTemporary") {
      events[index][1].type = types.data;
    }
  }

  return events;
};

/** @this {TokenizeContext} */
const tokenizeHighlightSyntax: Tokenizer = function tokenizeHighlightSyntax(
  this: TokenizeContext,
  effects,
  ok,
  nok,
) {
  const previous = this.previous;
  const events = this.events;
  let size = 0;

  return start;

  function start(code: number | null): State | undefined {
    if (
      previous === codes.equalsTo &&
      events[events.length - 1][1].type !== types.characterEscape
    ) {
      return nok(code);
    }
    effects.enter("highlightSequenceTemporary");
    return more(code);
  }

  function more(code: number | null): State | undefined {
    const before = classifyCharacter(previous);

    if (code === codes.equalsTo) {
      if (size > 1) return nok(code);
      effects.consume(code);
      size++;
      return more;
    }

    // Require exactly 2 markers (==)
    if (size < 2) return nok(code);
    const token = effects.exit("highlightSequenceTemporary");
    const after = classifyCharacter(code);
    token._open = !after || (after === constants.attentionSideAfter && Boolean(before));
    token._close = !before || (before === constants.attentionSideAfter && Boolean(after));
    return ok(code);
  }
};

// ── mdast-util extension ───────────────────────────────────────

/** Create an mdast-util-from-markdown extension for ==highlight==. */
export function highlightFromMarkdown(): FromMdExtension {
  return {
    canContainEols: ["highlight"],
    enter: {
      highlight: function (this: CompileContext, token) {
        this.enter(
          // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Custom node type not in mdast's union; cast required for extension pattern
          { type: "highlight", children: [] } as unknown as Nodes,
          token,
        );
      },
    },
    exit: {
      highlight: function (this: CompileContext, token) {
        this.exit(token);
      },
    },
  };
}
