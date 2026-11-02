import { describe, it, expect, vi, beforeEach } from "vitest";

import { installMockAPIs, render, screen, userEvent, within } from "@/test-utils";
import type { PermissionCardData } from "@/types/electron";

import type { TimelineItem } from "../hooks/useTimeline";
import { AssistantRun } from "./AssistantRun";
import type { Message } from "./ChatMessage";

beforeEach(() => {
  installMockAPIs();
});

function makeMessage(id: string, content = `msg-${id}`): Message {
  return { id, role: "assistant", content, timestamp: new Date() };
}

function makePermissionCard(
  id: string,
  overrides: Partial<PermissionCardData> = {},
): PermissionCardData {
  return {
    id,
    kind: "shell",
    title: `card-${id}`,
    message: "wants to run a command",
    detail: `echo ${id}`,
    buttons: ["Allow", "Deny"],
    resolved: "allowed",
    output: "done",
    createdAt: Date.now(),
    ...overrides,
  };
}

function msgItem(msg: Message): TimelineItem {
  return { kind: "message", data: msg };
}

function permItem(cards: PermissionCardData[]): TimelineItem {
  return { kind: "permissions", data: cards };
}

const defaultProps = {
  onPermissionRespond: vi.fn<(id: string, action: string) => void>(),
  renderMessage: (msg: Message) => <div data-testid={`rendered-${msg.id}`}>{msg.content}</div>,
};

describe("AssistantRun", () => {
  it("renders a single message item", () => {
    const items = [msgItem(makeMessage("m1"))];
    render(<AssistantRun items={items} {...defaultProps} />);

    expect(screen.getByTestId("rendered-m1")).toBeInTheDocument();
  });

  it("renders multi-item run", () => {
    const items = [msgItem(makeMessage("m1")), msgItem(makeMessage("m2"))];
    render(<AssistantRun items={items} {...defaultProps} />);

    expect(screen.getByTestId("rendered-m1")).toBeInTheDocument();
    expect(screen.getByTestId("rendered-m2")).toBeInTheDocument();
  });

  it("renders the Wayfinder Marshal avatar", () => {
    const items = [msgItem(makeMessage("m1"))];
    render(<AssistantRun items={items} {...defaultProps} />);

    expect(screen.queryByTestId("assistant-run-avatar-img")).not.toBeInTheDocument();
    const avatar = screen.getByTestId("assistant-run-avatar");
    const icon = within(avatar).getByTestId("bot-icon");
    expect([...icon.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual([
      "M5 18V7.5L12 13l7-5.5V18",
      "m5 7.5 7-3 7 3",
    ]);
  });

  it("uses the Wayfinder avatar for the default soul", () => {
    const items = [msgItem(makeMessage("m1"))];
    render(<AssistantRun items={items} {...defaultProps} soulId="default" />);

    expect(screen.getByTestId("bot-icon")).toBeInTheDocument();
  });

  it("renders permission card groups", () => {
    const cards = [makePermissionCard("p1"), makePermissionCard("p2")];
    const items = [permItem(cards)];
    render(<AssistantRun items={items} {...defaultProps} />);

    expect(screen.getByTestId("assistant-run-permissions")).toBeInTheDocument();
    expect(screen.getByText("card-p1")).toBeInTheDocument();
    expect(screen.getByText("card-p2")).toBeInTheDocument();
  });

  it("renders trailing content when provided", () => {
    const items = [msgItem(makeMessage("m1"))];
    const trailing = <div data-testid="trailing-node">Live content</div>;
    render(<AssistantRun items={items} {...defaultProps} trailing={trailing} />);

    expect(screen.getByTestId("trailing-node")).toBeInTheDocument();
  });

  it("does not render trailing step when trailing is undefined", () => {
    const items = [msgItem(makeMessage("m1"))];
    render(<AssistantRun items={items} {...defaultProps} />);

    expect(screen.getByTestId("rendered-m1")).toBeInTheDocument();
    expect(screen.queryByText("Live content")).not.toBeInTheDocument();
  });

  it("calls onPermissionRespond when permission card button is clicked", async () => {
    const user = userEvent.setup();
    const onRespond = vi.fn<(id: string, action: string) => void>();
    const cards = [makePermissionCard("p1", { resolved: undefined, output: undefined })];
    const items = [permItem(cards)];
    render(<AssistantRun items={items} {...defaultProps} onPermissionRespond={onRespond} />);

    await user.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onRespond).toHaveBeenCalledWith("p1", "allow");
  });

  it("keeps the canonical Marshal avatar when a non-default soul is set", () => {
    const items = [msgItem(makeMessage("m1"))];
    render(<AssistantRun items={items} {...defaultProps} soulId="operator" />);

    expect(screen.getByTestId("bot-icon")).toBeInTheDocument();
  });

  it("renders empty items list with only trailing", () => {
    const trailing = <div data-testid="only-trailing">Pending</div>;
    render(<AssistantRun items={[]} {...defaultProps} trailing={trailing} />);

    expect(screen.getByTestId("only-trailing")).toBeInTheDocument();
  });
});
