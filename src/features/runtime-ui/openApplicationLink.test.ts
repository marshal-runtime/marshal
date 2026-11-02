import { afterEach, describe, expect, it, vi } from "vitest";

import { openApplicationLink } from "./openApplicationLink";

describe("openApplicationLink", () => {
  afterEach(() => {
    delete window.marshalRemote;
    vi.restoreAllMocks();
  });

  it("refuses anything but http(s) links", async () => {
    const openExternal = vi.fn<(url: string) => Promise<{ success: boolean }>>();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only openExternal is exercised
    window.shellAPI = { openExternal } as unknown as typeof window.shellAPI;
    // eslint-disable-next-line no-script-url -- proves script URLs are refused
    await expect(openApplicationLink("javascript:alert(1)")).rejects.toThrow(/only web links/i);
    await expect(openApplicationLink("file:///etc/passwd")).rejects.toThrow(/only web links/i);
    await expect(openApplicationLink("not a url")).rejects.toThrow(/not a valid url/i);
    await expect(openApplicationLink(42)).rejects.toThrow(/required/i);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("hands desktop links to the main process's validated opener", async () => {
    const openExternal = vi.fn<(url: string) => Promise<{ success: boolean }>>(async () => ({
      success: true,
    }));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only openExternal is exercised
    window.shellAPI = { openExternal } as unknown as typeof window.shellAPI;
    await expect(openApplicationLink("https://github.com/login/device")).resolves.toEqual({});
    expect(openExternal).toHaveBeenCalledWith("https://github.com/login/device");
  });

  it("opens a browser tab on the phone instead of on the Mac", async () => {
    window.marshalRemote = true;
    const openExternal = vi.fn<(url: string) => Promise<{ success: boolean }>>();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only openExternal is exercised
    window.shellAPI = { openExternal } as unknown as typeof window.shellAPI;
    const tab = { opener: window as unknown };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only opener is read
    const open = vi.spyOn(window, "open").mockReturnValue(tab as Window);
    await expect(openApplicationLink("https://example.com/a?b=c")).resolves.toEqual({});
    expect(open).toHaveBeenCalledWith("https://example.com/a?b=c", "_blank");
    expect(tab.opener).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
    open.mockReturnValue(null);
    await expect(openApplicationLink("https://example.com")).rejects.toThrow(/blocked/i);
  });
});
