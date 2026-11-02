import { beforeEach, describe, expect, it, vi } from "vitest";

import { installMockAPIs, render, screen } from "@/test-utils";

import { AboutSection } from "./AboutSection";

describe("AboutSection", () => {
  beforeEach(() => {
    installMockAPIs();
  });

  it("shows the app version", async () => {
    vi.mocked(window.copilotAPI.getVersion).mockResolvedValue({ success: true, version: "0.0.1" });
    render(<AboutSection isOpen />);
    expect(await screen.findByText("Version 0.0.1")).toBeInTheDocument();
  });

  it("does not offer update checks or a Beta channel", () => {
    render(<AboutSection isOpen />);
    expect(screen.queryByRole("button", { name: /check for updates/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /beta updates/i })).not.toBeInTheDocument();
  });
});
