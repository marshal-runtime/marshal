import assert from "node:assert/strict";
import test from "node:test";

import { getToolTrace } from "./marshal-cdp-helpers.mjs";

test("getToolTrace expands activity groups before individual tool rows", async () => {
  const expressions = [];
  const Runtime = {
    evaluate: async ({ expression }) => {
      expressions.push(expression);
      return { result: { value: expression.includes("return [...rows]") ? [] : true } };
    },
  };

  await getToolTrace(Runtime, true);

  assert.equal(expressions.length, 3);
  assert.match(expressions[0], /tool-status-toggle/);
  assert.match(expressions[0], /committed-tool-calls-toggle/);
  assert.match(expressions[1], /tool-status-row-toggle/);
  assert.match(expressions[1], /committed-tool-call-toggle/);
  assert.match(expressions[2], /tool-status-line/);
});
