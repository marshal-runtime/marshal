/* marshal-owned */
/**
 * SF-4 oxlint plugin: enforce safe deserialization for JSON.parse() calls.
 *
 * Every JSON.parse() in electron production code must be one of:
 *   (a) annotated with // SF-4: <reason> on the same or preceding line
 *   (b) cast to `unknown` (not double-cast `as unknown as T`)
 *   (c) on the same line or immediately followed by safeParse / safeParseJson
 */

const SF4_RE = /SF-4:/;
const SAFE_CALL_RE = /safeParse|safeParseJson/;

function isJsonParse(node) {
  const c = node.callee;
  return (
    c.type === "MemberExpression" &&
    !c.computed &&
    c.object.type === "Identifier" &&
    c.object.name === "JSON" &&
    c.property.name === "parse"
  );
}

function isCastToUnknown(node) {
  const parent = node.parent;
  if (
    !parent ||
    parent.type !== "TSAsExpression" ||
    parent.typeAnnotation.type !== "TSUnknownKeyword"
  ) {
    return false;
  }
  // Reject double-cast: `JSON.parse(...) as unknown as T`
  const grandparent = parent.parent;
  return !grandparent || grandparent.type !== "TSAsExpression";
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unguarded JSON.parse() — require SF-4 annotation, " +
        "`as unknown` cast, or adjacent safeParse call",
    },
    messages: {
      unsafe:
        "SF-4 violation: unguarded JSON.parse(). " +
        "Annotate with // SF-4: <reason>, cast to `unknown`, " +
        "or follow with a safeParse / safeParseJson call.",
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.sourceCode;
    const lines = sourceCode.getText().split("\n");

    // Pre-index line numbers that contain an SF-4 line comment
    const sf4Lines = new Set();
    for (const comment of sourceCode.getAllComments()) {
      if (comment.type === "Line" && SF4_RE.test(comment.value)) {
        sf4Lines.add(comment.loc.start.line);
      }
    }

    return {
      CallExpression(node) {
        if (!isJsonParse(node)) return;

        const line = node.loc.start.line; // 1-based

        // (a) SF-4 comment on same line or preceding line
        if (sf4Lines.has(line) || sf4Lines.has(line - 1)) return;

        // (b) cast to `unknown` (single cast only)
        if (isCastToUnknown(node)) return;

        // (c) safeParse / safeParseJson on the same line or next non-empty line
        const idx = line - 1; // 0-based
        if (SAFE_CALL_RE.test(lines[idx] || "")) return;

        let nextIdx = idx + 1;
        while (nextIdx < lines.length && lines[nextIdx].trim() === "") nextIdx++;
        if (SAFE_CALL_RE.test(lines[nextIdx] || "")) return;

        context.report({ node, messageId: "unsafe" });
      },
    };
  },
};

export default {
  meta: { name: "sf4" },
  rules: {
    "no-bare-json-parse": rule,
  },
};
