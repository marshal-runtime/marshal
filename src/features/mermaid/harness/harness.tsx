/* eslint-disable react-refresh/only-export-components -- dev harness entry point, not a module. */
import "@/index.css";
import { createRoot } from "react-dom/client";

import { MermaidDiagram } from "@/features/mermaid/MermaidDiagram";
import { MarkdownRenderer } from "@/plugins/streamdown-config";

import datadog from "../fixtures/datadog-investigator-flowchart.mmd?raw";
import longLabels from "../fixtures/long-labels-flowchart.mmd?raw";
import sequence from "../fixtures/sequence-small.mmd?raw";

const fixtures: Record<string, string> = {
  datadog,
  "long-labels": longLabels,
  sequence,
  broken: "flowchart TD\n  A[Start --> B{oops",
};

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const surface = params.get("surface") === "preview" ? "preview" : "chat";
const selected = (params.get("fixtures") ?? "sequence,long-labels,datadog").split(",");
document.documentElement.setAttribute("data-theme", theme);

function Harness() {
  return (
    <div className="min-h-screen bg-background px-3 py-6 text-foreground sm:px-6">
      <div className="mx-auto flex max-w-[760px] flex-col gap-8">
        {selected.map((name) => {
          const source = fixtures[name] ?? "";
          return (
            <section key={name} data-fixture={name}>
              <div className="mb-2 font-mono text-xs text-muted-foreground">{name}</div>
              {surface === "chat" ? (
                <div className="text-base leading-[1.7] wrap-break-word text-foreground">
                  <MarkdownRenderer>
                    {"Here is the diagram:\n\n```mermaid\n" + source + "\n```\n"}
                  </MarkdownRenderer>
                </div>
              ) : (
                <MermaidDiagram source={source} className="my-1" />
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) createRoot(rootElement).render(<Harness />);
