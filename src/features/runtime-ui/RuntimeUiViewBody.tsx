import type { RuntimeUiInstance } from "@common/runtime-ui";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/marshal-class-names";

import { isPackagedApplicationInstance } from "./RuntimeUiApplicationRegistry";
import { RuntimeUiDocumentCompanion } from "./RuntimeUiDocumentCompanion";
import {
  RuntimeUiFrameChromeContext,
  type RuntimeUiFrameChromeReporter,
} from "./runtimeUiFrameChrome";
import { RuntimeUiImageSelection } from "./RuntimeUiImageSelection";
import { RuntimeUiRenderer } from "./RuntimeUiRenderer";
import { RuntimeUiSessionSelection } from "./RuntimeUiSessionSelection";

const NO_CHROME: RuntimeUiFrameChromeReporter = { report: () => {} };

/**
 * One view's content without any header: the dock tab (or the card frame)
 * owns the title and the close affordance.
 */
export function RuntimeUiViewBody({
  instance,
  fill,
  className,
}: {
  readonly instance: RuntimeUiInstance;
  /** Fill the container (docked tabs) instead of taking natural height (cards). */
  readonly fill: boolean;
  readonly className?: string;
}) {
  const bounded =
    fill && (isPackagedApplicationInstance(instance) || instance.content.kind === "file");
  return (
    <RuntimeUiFrameChromeContext value={NO_CHROME}>
      <RuntimeUiSessionSelection instance={instance}>
        <RuntimeUiImageSelection instance={instance}>
          <RuntimeUiDocumentCompanion instance={instance}>
            {bounded ? (
              // Bounded applications and native editors own their scrolling.
              <div className={cn("flex size-full min-h-0 flex-1 flex-col", className)}>
                <RuntimeUiRenderer instance={instance} layout="fill" />
              </div>
            ) : fill ? (
              <ScrollArea className={cn("size-full min-h-0 flex-1", className)}>
                <div className="p-4">
                  <RuntimeUiRenderer instance={instance} />
                </div>
              </ScrollArea>
            ) : (
              <div className={className}>
                <RuntimeUiRenderer instance={instance} />
              </div>
            )}
          </RuntimeUiDocumentCompanion>
        </RuntimeUiImageSelection>
      </RuntimeUiSessionSelection>
    </RuntimeUiFrameChromeContext>
  );
}
