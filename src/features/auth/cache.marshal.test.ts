// marshal-owned renderer test
import { QueryClient } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";

import { AUTH_KEYS, overwriteAuthCache } from "./cache";

describe("overwriteAuthCache", () => {
  it("cancels in-flight queries before writing, so a late-settling fetch cannot stomp the write", async () => {
    const qc = new QueryClient();
    const cancelSpy = vi.spyOn(qc, "cancelQueries");
    const setSpy = vi.spyOn(qc, "setQueryData");

    await overwriteAuthCache(qc, AUTH_KEYS.github, { signedIn: true });

    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: AUTH_KEYS.github });
    expect(setSpy).toHaveBeenCalledWith(AUTH_KEYS.github, { signedIn: true });
    // Order: cancel first, then set
    const cancelOrder = cancelSpy.mock.invocationCallOrder[0];
    const setOrder = setSpy.mock.invocationCallOrder[0];
    expect(cancelOrder).toBeLessThan(setOrder);
  });

  it("resolves only after cancelQueries settles", async () => {
    const qc = new QueryClient();
    let cancelResolved = false;
    vi.spyOn(qc, "cancelQueries").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      cancelResolved = true;
    });

    const promise = overwriteAuthCache(qc, AUTH_KEYS.github, { x: 1 });
    await promise;
    expect(cancelResolved).toBe(true);
  });
});
