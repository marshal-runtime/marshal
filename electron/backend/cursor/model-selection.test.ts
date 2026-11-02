import type { SDKModel } from "@cursor/sdk";
import { describe, expect, it } from "vitest";

import { CURSOR_MODEL_PARAM_FAST, CURSOR_MODEL_PARAM_OPTIMIZE_FOR } from "./constants";
import { mapCursorModel, toCursorModelSelection } from "./model-selection";

const GPT_MODEL_ID = "gpt-5.4";
const COMPOSER_MODEL_ID = "composer-2.5";
const AUTO_SMART_MODEL_ID = "auto-smart";
const REASONING_PARAM_ID = "reasoning";
const THINKING_PARAM_ID = "thinking";

const GPT_WITH_REASONING: SDKModel = {
  id: GPT_MODEL_ID,
  displayName: "GPT-5.4",
  parameters: [
    {
      id: REASONING_PARAM_ID,
      displayName: "Reasoning",
      values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }],
    },
  ],
};

describe("mapCursorModel", () => {
  describe("Sanity Tests", () => {
    it("copies catalog reasoning levels onto the runtime model", () => {
      expect(mapCursorModel(GPT_WITH_REASONING)).toMatchObject({
        id: GPT_MODEL_ID,
        name: "GPT-5.4",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "low",
        capabilities: { supports: { reasoningEffort: true } },
      });
    });
  });

  describe("Error Handling", () => {
    it("does not advertise reasoning for Fast or Router parameters", () => {
      const composer: SDKModel = {
        id: COMPOSER_MODEL_ID,
        displayName: "Composer 2.5",
        parameters: [
          {
            id: CURSOR_MODEL_PARAM_FAST,
            values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
          },
        ],
      };
      const router: SDKModel = {
        id: AUTO_SMART_MODEL_ID,
        displayName: "Cursor Router",
        parameters: [
          {
            id: CURSOR_MODEL_PARAM_OPTIMIZE_FOR,
            values: [{ value: "cost" }, { value: "balanced" }, { value: "intelligence" }],
          },
        ],
      };
      expect(mapCursorModel(composer).supportedReasoningEfforts).toBeUndefined();
      expect(mapCursorModel(composer).capabilities).toBeUndefined();
      expect(mapCursorModel(router).supportedReasoningEfforts).toBeUndefined();
    });
  });

  describe("Edge Cases", () => {
    it("ignores a thinking parameter whose values are not reasoning efforts", () => {
      const model: SDKModel = {
        id: GPT_MODEL_ID,
        displayName: "GPT-5.4",
        parameters: [
          {
            id: THINKING_PARAM_ID,
            values: [{ value: "true" }, { value: "false" }],
          },
        ],
      };
      expect(mapCursorModel(model).supportedReasoningEfforts).toBeUndefined();
    });

    it("uses the default variant's reasoning value when present", () => {
      const model: SDKModel = {
        ...GPT_WITH_REASONING,
        variants: [
          {
            displayName: "High",
            isDefault: true,
            params: [{ id: REASONING_PARAM_ID, value: "high" }],
          },
        ],
      };
      expect(mapCursorModel(model).defaultReasoningEffort).toBe("high");
    });
  });
});

describe("toCursorModelSelection", () => {
  describe("Sanity Tests", () => {
    it("attaches reasoning effort as a catalog param", () => {
      expect(toCursorModelSelection([GPT_WITH_REASONING], GPT_MODEL_ID, "high")).toEqual({
        id: GPT_MODEL_ID,
        params: [{ id: REASONING_PARAM_ID, value: "high" }],
      });
    });
  });

  describe("Error Handling", () => {
    it("omits params when the catalog has no reasoning parameter", () => {
      expect(toCursorModelSelection([], GPT_MODEL_ID, "high")).toEqual({ id: GPT_MODEL_ID });
    });
  });

  describe("Edge Cases", () => {
    it("omits params when effort is unset or not in the catalog values", () => {
      expect(toCursorModelSelection([GPT_WITH_REASONING], GPT_MODEL_ID)).toEqual({
        id: GPT_MODEL_ID,
      });
      expect(toCursorModelSelection([GPT_WITH_REASONING], GPT_MODEL_ID, "max")).toEqual({
        id: GPT_MODEL_ID,
      });
    });
  });
});
