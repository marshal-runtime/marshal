import type { IUpdateProvider } from "../platform/updates/ports";
import { EndpointUpdateProvider } from "./endpoint-provider";

export function selectUpdateProvider(): IUpdateProvider {
  return new EndpointUpdateProvider();
}
