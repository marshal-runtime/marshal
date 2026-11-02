import type { Rectangle } from "electron";

import {
  getIndicatorWindowHeight,
  getIndicatorWindowWidth,
  type MiniModeSizes,
  type MiniModeWindowLayout,
} from "./contracts";

interface IndicatorWindowLayoutInput {
  bubbleType: "none" | "notification" | "approval";
  sizes: MiniModeSizes;
  workArea: Rectangle;
}

export function getIndicatorWindowLayout({
  bubbleType,
  sizes,
  workArea,
}: IndicatorWindowLayoutInput): MiniModeWindowLayout {
  const dimensions = {
    width: getIndicatorWindowWidth(bubbleType, sizes),
    height: getIndicatorWindowHeight(bubbleType, sizes),
  };

  return {
    bounds: {
      x: workArea.x + workArea.width - dimensions.width - sizes.miniMargin,
      y: workArea.y + workArea.height - dimensions.height - sizes.miniMargin,
      width: dimensions.width,
      height: dimensions.height,
    },
    indicatorSize: sizes.indicatorSize,
    bubbleType,
  };
}
