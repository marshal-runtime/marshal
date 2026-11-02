/**
 * doc-translation — translate a markdown source to N languages with a
 * per-unit reviewer. Each language is one fanOut unit; review-rework
 * loops inside the unit body. Per c-sdk.md §11.c.
 */
import { defineWorkflow } from "@marshal/workflow-sdk";
import { z } from "zod";

const Params = z.object({
  srcPath: z.string().describe("Repo-relative path to the source markdown"),
  langs: z.array(z.string()).min(1).describe("Target languages (ISO codes)"),
  maxRetries: z.number().int().min(1).max(5).default(2),
});

const Source = z.object({ markdown: z.string() });
const Translation = z.object({ lang: z.string(), markdown: z.string() });
const Review = z.object({ pass: z.boolean(), feedback: z.string() });

type ParamsT = z.infer<typeof Params>;
type SourceT = z.infer<typeof Source>;
type TranslationT = z.infer<typeof Translation>;
type ReviewT = z.infer<typeof Review>;

export default defineWorkflow<ParamsT, { translations: number; langs: string[] }>({
  id: "doc-translation",
  displayName: "Translate document",
  description: "Translate a markdown doc to N languages with per-language QA.",
  schemaVersion: 1,
  params: Params,
  defaultBudget: 6,

  run: async (ctx) => {
    const source = await ctx.step("read-source", () =>
      ctx.run<SourceT>(
        { agentName: "general-purpose", displayName: "Read source" },
        `Read ${ctx.input.srcPath} verbatim. Reply ONLY with JSON: {"markdown":"<file contents>"}`,
        { schema: Source },
      ),
    );

    const results = await ctx.fanOut<string, TranslationT>(
      ctx.input.langs,
      async (lang, _idx) => {
        let translated = await ctx.run<TranslationT>(
          { agentName: "translator", displayName: `translate-${lang}` },
          `Translate the following markdown to ${lang}. Preserve fences and headings.\n\n` +
            source.markdown +
            `\n\nReply ONLY with JSON: {"lang":"${lang}","markdown":"<translated>"}`,
          { schema: Translation },
        );

        for (let attempt = 0; attempt < ctx.input.maxRetries; attempt++) {
          const review = await ctx.run<ReviewT>(
            { agentName: "translation-reviewer", displayName: `review-${lang}-${attempt}` },
            `Review this ${lang} translation for native fluency:\n${JSON.stringify(translated)}\n` +
              `Reply ONLY with JSON: {"pass":<bool>,"feedback":"<text>"}`,
            { schema: Review },
          );
          if (review.pass) break;
          ctx.log.warn(`rework ${lang} attempt ${attempt + 1}: ${review.feedback}`);
          translated = await ctx.run<TranslationT>(
            { agentName: "translator", displayName: `rework-${lang}-${attempt}` },
            `Rework this ${lang} translation per the reviewer feedback:\n${review.feedback}\n\n` +
              `Prior:\n${translated.markdown}\n\n` +
              `Reply ONLY with JSON: {"lang":"${lang}","markdown":"<new>"}`,
            { schema: Translation },
          );
        }

        await ctx.saveArtifact(`README.${lang}.md`, translated.markdown, {
          mime: "text/markdown",
        });
        return translated;
      },
      {
        maxConcurrency: 4,
        keyFor: (l) => l,
        onUnitFailure: { kind: "continue" },
      },
    );

    const ok = results.filter((r): r is TranslationT => Boolean(r));
    return { translations: ok.length, langs: ok.map((r) => r.lang) };
  },
});
