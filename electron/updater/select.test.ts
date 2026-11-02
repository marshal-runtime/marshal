import { describe, expect, it } from "vitest";

import { EndpointUpdateProvider } from "./endpoint-provider";
import { selectUpdateProvider } from "./select";

describe("selectUpdateProvider", () => {
  it("always returns the endpoint provider", () => {
    expect(selectUpdateProvider()).toBeInstanceOf(EndpointUpdateProvider);
  });
});
