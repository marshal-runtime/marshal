import type { RuntimeUiApplicationRenderer } from "./RuntimeUiApplicationRegistry";
import { SwarmRunRenderer } from "./SwarmRunRenderer";

export const swarmRunRuntimeUiRenderer: RuntimeUiApplicationRenderer = (props) => (
  <SwarmRunRenderer key={props.instance.instanceId} {...props} />
);
