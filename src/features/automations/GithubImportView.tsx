import { useState } from "react";

import { AlertTriangle, Loader } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/marshal-ui/alert";
import { Button } from "@/components/marshal-ui/marshal-button";
import { Input } from "@/components/marshal-ui/input";
import { Label } from "@/components/marshal-ui/label";

interface GithubImportViewProps {
  onBack: () => void;
  /** Called on successful import with a human-readable summary string. */
  onImported: (summary: string) => void;
}

export function GithubImportView({ onBack, onImported }: GithubImportViewProps) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<"idle" | "fetching" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(false);

  const handleImport = async () => {
    if (!window.automationsAPI || !url.trim()) return;
    setStatus("fetching");
    setError(null);

    const result = await window.automationsAPI.importFromGithub(
      url.trim(),
      token.trim() || undefined,
    );

    if (result.success) {
      const wfCount = result.automations?.length ?? 0;
      const skillCount = result.skillsInstalled?.length ?? 0;
      const parts: string[] = [];
      if (wfCount > 0) parts.push(`${wfCount} automation${wfCount !== 1 ? "s" : ""}`);
      if (skillCount > 0) parts.push(`${skillCount} skill${skillCount !== 1 ? "s" : ""}`);
      onImported(parts.length > 0 ? `Imported ${parts.join(" and ")}` : "Import complete");
    } else if (result.needsToken) {
      setStatus("idle");
      setNeedsToken(true);
      setError(result.error ?? "Authentication required");
    } else {
      setStatus("error");
      setError(result.error ?? "Import failed");
    }
  };

  return (
    <div className="flex flex-col gap-6 p-4">
      <h3 className="text-lg font-semibold">Import from GitHub</h3>

      <div className="flex flex-col gap-2">
        <Label htmlFor="github-url">Repository URL</Label>
        <Input
          id="github-url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setNeedsToken(false);
            setError(null);
          }}
          placeholder="https://github.com/org/repo/tree/main/automations"
          disabled={status === "fetching"}
        />
        <p className="text-xs text-muted-foreground">
          Point to a directory containing .json automation files. A skills/ subdirectory will be
          installed automatically.
        </p>
        <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-200">
          <AlertTriangle className="size-4 text-amber-500" aria-hidden="true" />
          <AlertTitle>GitHub import warning</AlertTitle>
          <AlertDescription className="text-xs">
            Only import automations and skills from GitHub sources you trust. Imported content can
            change how the agent behaves.
          </AlertDescription>
        </Alert>
      </div>

      {needsToken && (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/50 p-4">
          <p className="text-xs font-semibold">GitHub token required</p>
          <p className="text-xs/relaxed text-muted-foreground">
            Private repos and rate-limited requests need a token. Create a{" "}
            <a
              href="https://github.com/settings/tokens/new?scopes=repo&description=Marshal+import"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Personal Access Token
            </a>{" "}
            with <strong>repo</strong> scope (or a fine-grained token with Contents read access),
            then paste it below. The token is stored encrypted on your device.
          </p>
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            disabled={status === "fetching"}
            autoFocus
          />
        </div>
      )}

      {status === "fetching" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader size={14} className="animate-spin" />
          Fetching from GitHub...
        </p>
      )}

      {error && !needsToken && (
        <div
          role="alert"
          className="rounded-lg border border-brand-border bg-(--color-danger-bg) p-3 text-sm text-(--color-danger)"
        >
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onBack}>
          Cancel
        </Button>
        <Button
          className="bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
          onClick={handleImport}
          disabled={status === "fetching" || !url.trim() || (needsToken && !token.trim())}
        >
          {status === "fetching" ? "Importing..." : "Import"}
        </Button>
      </div>
    </div>
  );
}
