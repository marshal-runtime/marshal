import type { ModelSelection, ModelParameterDefinition, SDKModel } from "@cursor/sdk";

import type { ReasoningEffort } from "../../../common/marshal-ipc-contract";
import type { RuntimeModelInfo } from "../runtime-contract";
import {
  CURSOR_MODEL_PARAM_FAST,
  CURSOR_MODEL_PARAM_OPTIMIZE_FOR,
  CURSOR_REASONING_PARAM_ID_PATTERN,
} from "./constants";

const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS);

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_SET.has(value);
}

function isExcludedParamId(id: string): boolean {
  return id === CURSOR_MODEL_PARAM_OPTIMIZE_FOR || id === CURSOR_MODEL_PARAM_FAST;
}

function isReasoningParameter(parameter: ModelParameterDefinition): boolean {
  if (isExcludedParamId(parameter.id)) return false;
  if (CURSOR_REASONING_PARAM_ID_PATTERN.test(parameter.id)) return true;
  return parameter.values.some((entry) => isReasoningEffort(entry.value));
}

function findReasoningParameter(model: SDKModel): ModelParameterDefinition | undefined {
  const candidates = (model.parameters ?? []).filter(isReasoningParameter);
  const withEffortValues = candidates.find((parameter) =>
    parameter.values.some((entry) => isReasoningEffort(entry.value)),
  );
  return withEffortValues ?? candidates[0];
}

function supportedEfforts(parameter: ModelParameterDefinition): ReasoningEffort[] {
  return parameter.values.map((entry) => entry.value).filter(isReasoningEffort);
}

function defaultEffort(
  model: SDKModel,
  parameter: ModelParameterDefinition,
): ReasoningEffort | undefined {
  const defaultVariant = model.variants?.find((variant) => variant.isDefault);
  const fromVariant = defaultVariant?.params.find((param) => param.id === parameter.id)?.value;
  if (isReasoningEffort(fromVariant)) return fromVariant;
  return parameter.values.map((entry) => entry.value).find(isReasoningEffort);
}

/** Maps a Cursor catalog model onto Marshal's runtime model, including reasoning levels. */
export function mapCursorModel(model: SDKModel): RuntimeModelInfo {
  const parameter = findReasoningParameter(model);
  const efforts = parameter ? supportedEfforts(parameter) : [];
  const defaultReasoningEffort = parameter ? defaultEffort(model, parameter) : undefined;
  return {
    id: model.id,
    name: model.displayName,
    supportedContextTiers: ["default"],
    ...(efforts.length > 0
      ? {
          supportedReasoningEfforts: efforts,
          ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
          capabilities: { supports: { reasoningEffort: true } },
        }
      : {}),
    billing: {
      description: model.description,
    },
  };
}

/** Builds a Cursor `ModelSelection`, attaching reasoning effort when the catalog allows it. */
export function toCursorModelSelection(
  models: readonly SDKModel[],
  modelId: string,
  reasoningEffort?: ReasoningEffort,
): ModelSelection {
  if (!reasoningEffort) return { id: modelId };
  const model = models.find((item) => item.id === modelId);
  const parameter = model ? findReasoningParameter(model) : undefined;
  if (!parameter) return { id: modelId };
  if (!parameter.values.some((entry) => entry.value === reasoningEffort)) return { id: modelId };
  return { id: modelId, params: [{ id: parameter.id, value: reasoningEffort }] };
}
