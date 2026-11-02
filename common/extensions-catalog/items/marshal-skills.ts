import type { CatalogItem } from "../contracts/types";

export const SKILL_ITEMS: CatalogItem[] = [
  {
    id: "skill-docx",
    type: "skills",
    name: "docx",
    displayName: "Word Documents",
    description:
      "Create, read, and edit Word documents (.docx) with formatting, tables, and images.",
    icon: "📄",
    author: "Built-in",
    tags: ["office", "word", "documents", "docx"],
    source: { type: "bundled" },
  },
  {
    id: "skill-pptx",
    type: "skills",
    name: "pptx",
    displayName: "PowerPoint",
    description:
      "Create, read, and edit PowerPoint presentations (.pptx) including slides, notes, and layouts.",
    icon: "📊",
    author: "Built-in",
    tags: ["office", "powerpoint", "presentations", "slides"],
    source: { type: "bundled" },
  },
  {
    id: "skill-xlsx",
    type: "skills",
    name: "xlsx",
    displayName: "Excel Spreadsheets",
    description:
      "Create, read, and edit Excel spreadsheets (.xlsx, .csv) with formulas, charts, and formatting.",
    icon: "📈",
    author: "Built-in",
    tags: ["office", "excel", "spreadsheets", "csv"],
    source: { type: "bundled" },
  },
  {
    id: "skill-excalidraw",
    type: "skills",
    name: "excalidraw",
    displayName: "Excalidraw Diagrams",
    description:
      "Generate Excalidraw diagrams — architecture diagrams, flowcharts, and data flow visualizations.",
    icon: "🎨",
    author: "Built-in",
    tags: ["design", "diagrams", "flowcharts", "excalidraw"],
    source: { type: "bundled" },
  },
  {
    id: "skill-web-artifacts-builder",
    type: "skills",
    name: "web-artifacts-builder",
    displayName: "Web App Builder",
    description:
      "Build interactive web apps, dashboards, and data visualizations as self-contained HTML artifacts using React, Tailwind CSS, and shadcn/ui.",
    icon: "🌐",
    author: "Built-in",
    tags: ["web", "react", "dashboard", "artifacts", "html"],
    source: { type: "bundled" },
  },
];
