// Marshal-owned module.
import { createLogger } from "@common/marshal-logger";
/**
 * Custom Shiki code-highlighter plugin for streamdown.
 *
 * Drop-in replacement for @streamdown/code that bundles only ~22 languages
 * instead of all 488. Everything is lazy-loaded via dynamic import():
 *
 * - The plugin object itself is a thin facade (near-zero main bundle cost)
 * - @shikijs/core + engine are loaded on first highlight() call
 * - Each language grammar is a separate chunk, loaded on demand
 * - Themes are loaded alongside the engine
 *
 * Vite/Rollup names chunks from the import path (e.g. `bash-HASH.js`).
 */
import type { CodeHighlighterPlugin } from "streamdown";

const log = createLogger("CodeHighlighter");

// ---------------------------------------------------------------------------
// Types — extracted from streamdown + shikijs via utility types
// ---------------------------------------------------------------------------

type HighlightResult = Parameters<
  NonNullable<Parameters<CodeHighlighterPlugin["highlight"]>[1]>
>[0];
type HighlightOptions = Parameters<CodeHighlighterPlugin["highlight"]>[0];
type ThemeInput = ReturnType<CodeHighlighterPlugin["getThemes"]>[number];
type HighlightCallback = (result: HighlightResult) => void;

// Shiki core types extracted from the module's public API
type CreateHighlighterCore = Awaited<typeof import("@shikijs/core")>["createHighlighterCore"];
type HighlighterCore = Awaited<ReturnType<CreateHighlighterCore>>;
type CoreOptions = Parameters<CreateHighlighterCore>[0];
type LanguageInput = NonNullable<CoreOptions["langs"]>[number];
type ShikiThemeInput = NonNullable<CoreOptions["themes"]>[number];

// ---------------------------------------------------------------------------
// Language registry — pure data, no heavy imports
// ---------------------------------------------------------------------------

interface LangEntry {
  aliases: string[];
  load: () => Promise<{ default: LanguageInput }>;
}

const LANGUAGES: Record<string, LangEntry> = {
  bash: {
    aliases: ["sh", "shell", "zsh", "bash"],
    load: () => import("@shikijs/langs/bash"),
  },
  csharp: {
    aliases: ["c#", "cs"],
    load: () => import("@shikijs/langs/csharp"),
  },
  css: {
    aliases: [],
    load: () => import("@shikijs/langs/css"),
  },
  dockerfile: {
    aliases: ["docker"],
    load: () => import("@shikijs/langs/dockerfile"),
  },
  go: {
    aliases: ["golang"],
    load: () => import("@shikijs/langs/go"),
  },
  graphql: {
    aliases: ["gql"],
    load: () => import("@shikijs/langs/graphql"),
  },
  html: {
    aliases: ["htm"],
    load: () => import("@shikijs/langs/html"),
  },
  java: {
    aliases: [],
    load: () => import("@shikijs/langs/java"),
  },
  javascript: {
    aliases: ["js"],
    load: () => import("@shikijs/langs/javascript"),
  },
  json: {
    aliases: ["jsonc", "json5"],
    load: () => import("@shikijs/langs/json"),
  },
  jsx: {
    aliases: [],
    load: () => import("@shikijs/langs/jsx"),
  },
  markdown: {
    aliases: ["md"],
    load: () => import("@shikijs/langs/markdown"),
  },
  powershell: {
    aliases: ["ps", "ps1", "pwsh"],
    load: () => import("@shikijs/langs/powershell"),
  },
  python: {
    aliases: ["py"],
    load: () => import("@shikijs/langs/python"),
  },
  ruby: {
    aliases: ["rb"],
    load: () => import("@shikijs/langs/ruby"),
  },
  rust: {
    aliases: ["rs"],
    load: () => import("@shikijs/langs/rust"),
  },
  sql: {
    aliases: [],
    load: () => import("@shikijs/langs/sql"),
  },
  toml: {
    aliases: [],
    load: () => import("@shikijs/langs/toml"),
  },
  tsx: {
    aliases: [],
    load: () => import("@shikijs/langs/tsx"),
  },
  typescript: {
    aliases: ["ts"],
    load: () => import("@shikijs/langs/typescript"),
  },
  xml: {
    aliases: [],
    load: () => import("@shikijs/langs/xml"),
  },
  yaml: {
    aliases: ["yml"],
    load: () => import("@shikijs/langs/yaml"),
  },
};

// Build lookup sets from the static config above
const supportedIds = new Set<string>();
const aliasToId = new Map<string, string>();

for (const [id, entry] of Object.entries(LANGUAGES)) {
  supportedIds.add(id);
  for (const alias of entry.aliases) {
    supportedIds.add(alias);
    aliasToId.set(alias, id);
  }
}

function resolveLanguage(lang: string): string {
  const t = lang.trim().toLowerCase();
  return aliasToId.get(t) ?? t;
}

// ---------------------------------------------------------------------------
// Lazy-loaded core — nothing from @shikijs/core enters the main bundle
// ---------------------------------------------------------------------------

interface CoreDeps {
  createHighlighterCore: CreateHighlighterCore;
  engine: Parameters<CreateHighlighterCore>[0]["engine"];
  themeLight: ShikiThemeInput;
  themeDark: ShikiThemeInput;
}

let corePromise: Promise<CoreDeps> | null = null;

function loadCore() {
  if (!corePromise) {
    corePromise = Promise.all([
      import("@shikijs/core"),
      import("@shikijs/engine-javascript"),
      import("@shikijs/themes/github-light"),
      import("@shikijs/themes/github-dark"),
    ]).then(([core, engineMod, lightMod, darkMod]) => ({
      createHighlighterCore: core.createHighlighterCore,
      engine: engineMod.createJavaScriptRegexEngine({ forgiving: true }),
      themeLight: lightMod.default as ShikiThemeInput,
      themeDark: darkMod.default as ShikiThemeInput,
    }));
  }
  return corePromise;
}

// ---------------------------------------------------------------------------
// Highlighter cache — one per language + theme combo
// ---------------------------------------------------------------------------

const highlighterCache = new Map<string, Promise<HighlighterCore>>();

function getThemeName(t: ThemeInput): string {
  return typeof t === "string" ? t : (t.name ?? "custom");
}

function getHighlighter(lang: string, themes: [ThemeInput, ThemeInput]) {
  const key = `${lang}-${getThemeName(themes[0])}-${getThemeName(themes[1])}`;
  if (highlighterCache.has(key)) return highlighterCache.get(key)!;

  const promise = loadCore().then(async (core) => {
    // Map theme name strings to loaded theme objects, pass through custom themes
    const resolveTheme = (t: ThemeInput) =>
      t === "github-light" ? core.themeLight : t === "github-dark" ? core.themeDark : t;

    // Load the language grammar chunk on demand
    const langEntry = LANGUAGES[lang];
    const langModule = langEntry ? (await langEntry.load()).default : undefined;

    return core.createHighlighterCore({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- resolveTheme returns ShikiThemeInput; tuple type required by createHighlighterCore
      themes: [resolveTheme(themes[0]), resolveTheme(themes[1])] as [
        ShikiThemeInput,
        ShikiThemeInput,
      ],
      langs: langModule ? [langModule] : [],
      engine: core.engine,
    });
  });

  highlighterCache.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Result cache + pending callbacks (same pattern as @streamdown/code)
// ---------------------------------------------------------------------------

const resultCache = new Map<string, HighlightResult>();
const inflightWork = new Map<string, Promise<void>>();
const pendingCallbacks = new Map<string, Set<HighlightCallback>>();

function cacheKey(code: string, lang: string, themes: [string, string]): string {
  const head = code.slice(0, 100);
  const tail = code.length > 100 ? code.slice(-100) : "";
  return `${lang}:${themes[0]}:${themes[1]}:${code.length}:${head}:${tail}`;
}

// ---------------------------------------------------------------------------
// Public plugin — thin facade, no heavy imports at module level
// ---------------------------------------------------------------------------

export const code: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",

  supportsLanguage(language) {
    return supportedIds.has(resolveLanguage(language));
  },

  getSupportedLanguages(): ReturnType<CodeHighlighterPlugin["getSupportedLanguages"]> {
    // Our IDs are a subset of BundledLanguage; TS can't verify this statically
    // since they come from a runtime Set, but the values match by construction.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- supportedIds values are BundledLanguage strings by construction
    return Array.from(supportedIds) as ReturnType<CodeHighlighterPlugin["getSupportedLanguages"]>;
  },

  getThemes(): [ThemeInput, ThemeInput] {
    return ["github-light", "github-dark"];
  },

  highlight(options: HighlightOptions, callback?: HighlightCallback) {
    const lang = resolveLanguage(options.language);
    const themeNames: [string, string] = [
      getThemeName(options.themes[0]),
      getThemeName(options.themes[1]),
    ];
    const key = cacheKey(options.code, lang, themeNames);

    // Return cached result immediately if available
    if (resultCache.has(key)) return resultCache.get(key)!;

    // Register callback for async delivery
    if (callback) {
      if (!pendingCallbacks.has(key)) pendingCallbacks.set(key, new Set());
      pendingCallbacks.get(key)!.add(callback);
    }

    const effectiveLang = LANGUAGES[lang] ? lang : "text";

    // Deduplicate in-flight work: reuse the existing promise if one is already running
    if (!inflightWork.has(key)) {
      const work = getHighlighter(effectiveLang, options.themes)
        .then((hl) => {
          const loaded = hl.getLoadedLanguages().includes(effectiveLang);
          const result: HighlightResult = hl.codeToTokens(options.code, {
            lang: loaded ? effectiveLang : "text",
            themes: { light: themeNames[0], dark: themeNames[1] },
          });

          resultCache.set(key, result);

          const cbs = pendingCallbacks.get(key);
          if (cbs) {
            for (const cb of cbs) cb(result);
            pendingCallbacks.delete(key);
          }
        })
        .catch((err) => {
          log.error("Failed to highlight code:", err);
          pendingCallbacks.delete(key);
        })
        .finally(() => {
          inflightWork.delete(key);
        });

      inflightWork.set(key, work);
    }

    return null;
  },
};
