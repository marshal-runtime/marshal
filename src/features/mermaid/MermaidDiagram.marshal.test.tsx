// marshal-owned renderer test
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRender = vi.fn<(...args: unknown[]) => Promise<{ svg: string }>>();
const mockInitialize = vi.fn<(...args: unknown[]) => void>();
vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => mockInitialize(...args),
    render: (...args: unknown[]) => mockRender(...args),
  },
}));

import { MermaidDiagram } from "./MermaidDiagram";

// Rendered SVGs are cached by source + theme, so each test uses its own source.
let sourceCounter = 0;
const uniqueSource = (body = "A-->B") => `graph TD; ${body} %% ${++sourceCounter}`;

let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  user = userEvent.setup();
  vi.clearAllMocks();
  document.documentElement.removeAttribute("data-theme");
});

describe("MermaidDiagram", () => {
  it("shows a pending state while Mermaid renders", () => {
    mockRender.mockReturnValue(new Promise(() => {}));
    render(<MermaidDiagram source={uniqueSource()} />);
    expect(screen.getByText("Rendering diagram…")).toBeInTheDocument();
  });

  it("renders the SVG with the Marshal base theme", async () => {
    mockRender.mockResolvedValue({
      svg: '<svg data-testid="mermaid-svg" viewBox="0 0 400 200"></svg>',
    });
    const source = uniqueSource();
    render(<MermaidDiagram source={source} />);

    expect(await screen.findByTestId("mermaid-svg")).toBeInTheDocument();
    expect(mockRender).toHaveBeenCalledWith(expect.stringContaining("marshal-mermaid-"), source);
    expect(screen.getByText("Flowchart")).toBeInTheDocument();
  });

  it("pins the SVG to its natural size so the stage transform does the scaling", async () => {
    mockRender.mockResolvedValue({
      svg: '<svg data-testid="sized" width="100%" style="max-width: 640px" viewBox="0 0 640 320"></svg>',
    });
    render(<MermaidDiagram source={uniqueSource()} />);
    const svg = await screen.findByTestId("sized");
    expect(svg.getAttribute("width")).toBe("640");
    expect(svg.getAttribute("height")).toBe("320");
    expect(svg.style.maxWidth).toBe("none");
  });

  it("shows the error together with the source when rendering fails", async () => {
    mockRender.mockRejectedValue(new Error("Parse error on line 2"));
    render(<MermaidDiagram source="not valid mermaid" />);

    expect(await screen.findByText(/Parse error on line 2/)).toBeInTheDocument();
    expect(screen.getByText(/Couldn’t render this diagram/)).toBeInTheDocument();
    expect(screen.getByText("not valid mermaid")).toBeInTheDocument();
  });

  it("does not render an empty source", async () => {
    render(<MermaidDiagram source="   " />);
    expect(screen.getByText("Empty diagram")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("waits for a streaming fence to complete before rendering", async () => {
    mockRender.mockResolvedValue({ svg: '<svg data-testid="streamed" viewBox="0 0 10 10"></svg>' });
    const source = uniqueSource();
    const { rerender } = render(<MermaidDiagram source={source} isIncomplete />);
    expect(screen.getByText("Drawing diagram…")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockRender).not.toHaveBeenCalled();

    rerender(<MermaidDiagram source={source} isIncomplete={false} />);
    expect(await screen.findByTestId("streamed")).toBeInTheDocument();
  });

  it("applies a custom className to the frame", () => {
    mockRender.mockReturnValue(new Promise(() => {}));
    const { container } = render(<MermaidDiagram source={uniqueSource()} className="my-4" />);
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    expect(container.firstElementChild?.classList.contains("my-4")).toBe(true);
  });

  it("re-renders when the source changes", async () => {
    mockRender.mockResolvedValue({ svg: "<svg>v1</svg>" });
    const { rerender } = render(<MermaidDiagram source={uniqueSource()} />);
    await waitFor(() => expect(mockRender).toHaveBeenCalledTimes(1));

    const next = uniqueSource("X-->Y");
    rerender(<MermaidDiagram source={next} />);
    await waitFor(() => expect(mockRender).toHaveBeenCalledTimes(2));
    expect(mockRender).toHaveBeenLastCalledWith(expect.any(String), next);
  });

  it("re-renders with the dark palette when the theme changes", async () => {
    mockRender.mockResolvedValue({ svg: "<svg>themed</svg>" });
    render(<MermaidDiagram source={uniqueSource()} />);
    await waitFor(() => expect(mockRender).toHaveBeenCalledTimes(1));

    await act(async () => {
      document.documentElement.setAttribute("data-theme", "dark");
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await waitFor(() => expect(mockRender).toHaveBeenCalledTimes(2));
    expect(mockInitialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: "base",
        securityLevel: "strict",
        themeVariables: expect.objectContaining({ darkMode: true }) as unknown,
      }),
    );
  });

  it("toggles between the diagram and its source", async () => {
    mockRender.mockResolvedValue({
      svg: '<svg data-testid="toggle-svg" viewBox="0 0 10 10"></svg>',
    });
    const source = uniqueSource();
    render(<MermaidDiagram source={source} />);
    await screen.findByTestId("toggle-svg");

    await user.click(screen.getByRole("button", { name: "View source" }));
    expect(screen.getByText(source)).toBeInTheDocument();
    expect(screen.queryByTestId("toggle-svg")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show diagram" }));
    expect(await screen.findByTestId("toggle-svg")).toBeInTheDocument();
  });

  it("copies the source to the clipboard", async () => {
    mockRender.mockResolvedValue({ svg: "<svg></svg>" });
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const source = uniqueSource();
    render(<MermaidDiagram source={source} />);

    await user.click(screen.getByRole("button", { name: "Copy source" }));
    expect(writeText).toHaveBeenCalledWith(source);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("keeps toolbar clicks from reaching the host, but lets a click on the diagram through", async () => {
    mockRender.mockResolvedValue({ svg: '<svg data-testid="host-svg" viewBox="0 0 10 10"></svg>' });
    const onHostClick = vi.fn<() => void>();
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={onHostClick}>
        <MermaidDiagram source={uniqueSource()} />
      </div>,
    );
    const svg = await screen.findByTestId("host-svg");

    await user.click(screen.getByRole("button", { name: "Copy source" }));
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(onHostClick).not.toHaveBeenCalled();

    await user.click(svg);
    expect(onHostClick).toHaveBeenCalledTimes(1);
  });
});
