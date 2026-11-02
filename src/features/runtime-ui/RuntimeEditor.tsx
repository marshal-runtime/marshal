import { createContext, type ComponentType } from "react";

export interface MarshalRuntimeEditorSource {
  readonly path: string;
  readonly name?: string;
  readonly language: string;
  readonly content?: string;
}

export interface MarshalRuntimeEditorBreakpoint {
  readonly line: number;
  readonly enabled: boolean;
  readonly origin: "agent" | "human";
}

export interface MarshalRuntimeEditorSourceProps {
  readonly source: MarshalRuntimeEditorSource;
  readonly breakpoints: readonly MarshalRuntimeEditorBreakpoint[];
  readonly currentLine?: number;
  readonly theme: "dark" | "light";
  readonly onToggleBreakpoint: (line: number) => void;
}

/**
 * Renderer-facing editor contract. The runtime UI only depends on this
 * interface so the host can replace Monaco without changing debugger UI.
 */
export interface MarshalRuntimeEditor {
  readonly id: string;
  readonly SourceEditor: ComponentType<MarshalRuntimeEditorSourceProps>;
}

export const MarshalRuntimeEditorContext = createContext<MarshalRuntimeEditor | null>(null);
