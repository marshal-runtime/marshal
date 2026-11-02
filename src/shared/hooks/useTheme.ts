import { useSyncExternalStore } from "react";

function subscribeToTheme(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function getThemeSnapshot(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** Reactive hook that tracks the document's data-theme attribute. */
export function useDocumentTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribeToTheme, getThemeSnapshot, () => "light" as const);
}
