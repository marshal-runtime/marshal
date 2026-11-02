import { describe, expect, it } from "vitest";

import { permissionNotificationBody } from "./permission-external-redaction";

describe("permissionNotificationBody", () => {
  it("never puts a memory being erased on the lock screen", () => {
    const message = "Marshal wants to permanently erase this memory.\n\n“private memory”";

    expect(permissionNotificationBody({ message, isForgetCompletely: true })).toBe(
      "Marshal wants to erase a memory permanently",
    );
    expect(permissionNotificationBody({ message: "Run npm test" })).toBe("Run npm test");
  });
});
