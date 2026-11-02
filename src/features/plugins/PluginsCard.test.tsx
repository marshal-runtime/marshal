import type { CatalogItem } from "@common/extensions-catalog/marshal-extension-catalog";
import { describe, it, expect, vi } from "vitest";

import { render, screen, userEvent } from "@/test-utils";

import { CatalogCard, CustomItemCard } from "./PluginsCard";

const catalogItem: CatalogItem = {
  id: "test-skill",
  type: "skills",
  name: "test-skill",
  displayName: "Test Skill",
  description: "A great testing skill",
  icon: "🧪",
  author: "Test Author",
  tags: ["test"],
  source: { type: "bundled" },
};

describe("CatalogCard", () => {
  it("renders displayName, description, and slash-name for skills", () => {
    render(
      <CatalogCard
        item={catalogItem}
        installState="available"
        onInstall={vi.fn<(item: CatalogItem) => void>()}
      />,
    );
    expect(screen.getByText("Test Skill")).toBeInTheDocument();
    expect(screen.getByText("A great testing skill")).toBeInTheDocument();
    expect(screen.getByText(/\/test-skill/)).toBeInTheDocument();
  });

  it("shows 'BUILT-IN' badge for built-in items", () => {
    render(
      <CatalogCard
        item={catalogItem}
        installState="built-in"
        onInstall={vi.fn<(item: CatalogItem) => void>()}
      />,
    );
    expect(screen.getByText("BUILT-IN")).toBeInTheDocument();
  });

  it("shows 'Use' button for installed items", () => {
    render(
      <CatalogCard
        item={catalogItem}
        installState="installed"
        onInstall={vi.fn<(item: CatalogItem) => void>()}
      />,
    );
    expect(screen.getByText("Use")).toBeInTheDocument();
  });

  it("calls onUse (not onInstall) when Use clicked on installed item", async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn<(item: CatalogItem) => void>();
    const onUse = vi.fn<(item: CatalogItem) => void>();
    render(
      <CatalogCard
        item={catalogItem}
        installState="installed"
        onInstall={onInstall}
        onUse={onUse}
      />,
    );
    await user.click(screen.getByText("Use"));
    expect(onUse).toHaveBeenCalledWith(catalogItem);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("shows 'Install' button for available items", () => {
    render(
      <CatalogCard
        item={catalogItem}
        installState="available"
        onInstall={vi.fn<(item: CatalogItem) => void>()}
      />,
    );
    expect(screen.getByText("Install")).toBeInTheDocument();
  });

  it("calls onInstall when Install clicked", async () => {
    const user = userEvent.setup();
    const onInstall = vi.fn<(item: CatalogItem) => void>();
    render(<CatalogCard item={catalogItem} installState="available" onInstall={onInstall} />);
    await user.click(screen.getByText("Install"));
    expect(onInstall).toHaveBeenCalledWith(catalogItem);
  });

  it("calls onClick when card clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn<() => void>();
    render(
      <CatalogCard
        item={catalogItem}
        installState="installed"
        onInstall={vi.fn<(item: CatalogItem) => void>()}
        onClick={onClick}
      />,
    );
    await user.click(screen.getByText("Test Skill"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("activates the card via Enter and Space when focused", async () => {
    // The card is a `<Card role="button">` rather than a real <button>, so the
    // keyboard contract is manual. Pin both Enter and Space — losing either
    // would silently regress a11y for keyboard-only users.
    const user = userEvent.setup();
    const onClick = vi.fn<() => void>();
    render(
      <CatalogCard
        item={catalogItem}
        installState="installed"
        onInstall={vi.fn<(item: CatalogItem) => void>()}
        onClick={onClick}
      />,
    );
    const card = screen.getByRole("button", { name: /Test Skill/ });
    card.focus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("does not double-fire onClick when an inner Install button is keyboard-activated", async () => {
    // The `target !== currentTarget` guard in `activateOnEnterOrSpace` is what
    // stops Enter/Space on an inner button from also firing the outer card's
    // onClick. Without it, pressing Enter on Install would fire both onInstall
    // AND onClick — two distinct user actions for one keystroke.
    const user = userEvent.setup();
    const onClick = vi.fn<() => void>();
    const onInstall = vi.fn<(item: CatalogItem) => void>();
    render(
      <CatalogCard
        item={catalogItem}
        installState="available"
        onInstall={onInstall}
        onClick={onClick}
      />,
    );
    const installBtn = screen.getByRole("button", { name: "Install" });
    installBtn.focus();
    await user.keyboard("{Enter}");
    expect(onInstall).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("hides action icons for available catalog items", () => {
    render(
      <CatalogCard
        item={catalogItem}
        installState="available"
        onInstall={vi.fn<(item: CatalogItem) => void>()}
        onOpenFile={vi.fn<(item: CatalogItem) => void>()}
        onUninstall={vi.fn<(item: CatalogItem) => void>()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open in Editor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Uninstall" })).not.toBeInTheDocument();
  });

  it("shows action icons for installed catalog items", () => {
    render(
      <CatalogCard
        item={catalogItem}
        installState="installed"
        onInstall={vi.fn<(item: CatalogItem) => void>()}
        onOpenFile={vi.fn<(item: CatalogItem) => void>()}
        onUninstall={vi.fn<(item: CatalogItem) => void>()}
      />,
    );
    expect(screen.getByRole("button", { name: "Open in Editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeInTheDocument();
  });

  it("shows 'Needs config' for needs-config state", () => {
    render(
      <CatalogCard
        item={catalogItem}
        installState="needs-config"
        onInstall={vi.fn<(item: CatalogItem) => void>()}
      />,
    );
    expect(screen.getByText("Needs config")).toBeInTheDocument();
  });
});

describe("CustomItemCard", () => {
  it("renders name and description", () => {
    render(<CustomItemCard name="My Custom" description="A custom item" />);
    expect(screen.getByText("My Custom")).toBeInTheDocument();
    expect(screen.getByText("A custom item")).toBeInTheDocument();
  });

  it("renders slug when provided", () => {
    render(<CustomItemCard name="My Custom" slug="my-custom" />);
    expect(screen.getByText("/my-custom")).toBeInTheDocument();
  });

  it("renders toggle switch and calls onToggle", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn<(enabled: boolean) => void>();
    render(<CustomItemCard name="My Custom" enabled={true} onToggle={onToggle} />);
    const toggle = screen.getByRole("switch");
    expect(toggle).toBeInTheDocument();
    await user.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("greys out content when disabled", () => {
    render(
      <CustomItemCard
        name="My Custom"
        enabled={false}
        onToggle={vi.fn<(enabled: boolean) => void>()}
      />,
    );
    const useBtn = screen.queryByText("Use");
    expect(useBtn).not.toBeInTheDocument();
  });

  it("renders Use button and action icons", () => {
    render(
      <CustomItemCard
        name="My Custom"
        onUse={vi.fn<() => void>()}
        onOpenFile={vi.fn<() => void>()}
        onUninstall={vi.fn<() => void>()}
      />,
    );
    expect(screen.getByText("Use")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in Editor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeInTheDocument();
  });

  it("activates the card via Enter and Space when focused", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn<() => void>();
    render(<CustomItemCard name="My Custom" onClick={onClick} />);
    const card = screen.getByRole("button", { name: /My Custom/ });
    card.focus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("calls onClick when clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn<() => void>();
    render(<CustomItemCard name="My Custom" onClick={onClick} />);
    await user.click(screen.getByText("My Custom"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not double-fire onClick when an inner action button is keyboard-activated", async () => {
    // Pin the `target !== currentTarget` guard for CustomItemCard too — the
    // inner action Button (`Use`) shares the same outer keyboard handler, and
    // a regression that drops the guard would silently break the contract.
    const user = userEvent.setup();
    const onClick = vi.fn<() => void>();
    const onAction = vi.fn<() => void>();
    render(
      <CustomItemCard
        name="My Custom"
        onClick={onClick}
        actionLabel="Sign in"
        onAction={onAction}
      />,
    );
    const actionBtn = screen.getByRole("button", { name: "Sign in" });
    actionBtn.focus();
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
  });
});
