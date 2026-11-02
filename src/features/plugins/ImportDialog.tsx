import { SKILL_IMPORT_DISMISSED } from "@common/marshal-ipc-contract";
import { useCallback, useRef, useState } from "react";

import { AlertTriangle, FileUp, FolderOpen, Globe, Loader2 } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/marshal-ui/alert";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/marshal-ui/input";
import { cn } from "@/lib/marshal-class-names";

export interface ImportResult {
  succeeded: string[];
  errors: Array<{ fileName: string; error: string }>;
}

interface ImportDialogProps {
  onClose: () => void;
  onImportFiles: (files: Array<{ content: string; name: string }>) => Promise<ImportResult>;
  onUrlImport: (url: string) => Promise<void>;
  onImportBundle: (dirPath?: string) => Promise<void>;
}

const IMPORT_CONFIG = {
  title: "Import Skill",
  accept: ".md",
  hint: "Drop .md skill files here",
  urlPlaceholder: "Paste raw SKILL.md URL (e.g. GitHub raw link)",
  urlTip: "Tip: On GitHub, click a SKILL.md file, then Raw, then copy the URL to import.",
  bundleHint: "Drop a skill folder here",
  bundleDescription: "or click to browse for a directory with SKILL.md and supporting files",
} as const;

/** Read all files from a FileList as text. Returns content or per-file errors in selection order. */
async function readAllFiles(fileList: FileList): Promise<{
  files: Array<{ content: string; name: string }>;
  readErrors: Array<{ fileName: string; error: string }>;
}> {
  const results = await Promise.all(
    Array.from(fileList).map(async (file) => {
      try {
        return { ok: true as const, content: await file.text(), name: file.name };
      } catch (err) {
        return {
          ok: false as const,
          name: file.name,
          error: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }),
  );
  return {
    files: results
      .filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
      .map((r) => ({ content: r.content, name: r.name })),
    readErrors: results
      .filter((r): r is Extract<typeof r, { ok: false }> => !r.ok)
      .map((r) => ({ fileName: r.name, error: r.error })),
  };
}

/**
 * Check whether a DataTransfer contains at least one directory entry.
 * Returns the filesystem path of the first directory if resolvable via
 * preload's webUtils.getPathForFile wrapper, `true` if a directory is
 * detected but the path can't be read, or `null` if no directory was found.
 */
function getDroppedDirPath(dataTransfer: DataTransfer): string | true | null {
  const items = dataTransfer.items;
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      const file = dataTransfer.files[i];
      const path = file ? (window.workspaceAPI?.getPathForFile(file) ?? "") : "";
      if (path) return path;
      return true;
    }
  }
  return null;
}

export function ImportDialog({
  onClose,
  onImportFiles,
  onUrlImport,
  onImportBundle,
}: ImportDialogProps) {
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isDraggingBundle, setIsDraggingBundle] = useState(false);
  const [bundleImporting, setBundleImporting] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = bundleImporting;

  // ── File drop zone handlers ──────────────────────────────────────────

  const handleFileDragOver = useCallback(
    (e: React.DragEvent) => {
      if (busy) return;
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setIsDraggingFile(true);
      }
    },
    [busy],
  );

  const handleFileDragLeave = useCallback((e: React.DragEvent) => {
    if (
      e.currentTarget === e.target ||
      !(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))
    ) {
      setIsDraggingFile(false);
    }
  }, []);

  const handleFileDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingFile(false);
      setIsDraggingBundle(false);
      if (busy) return;
      setError(null);
      setImportResult(null);
      // Detect directories and redirect to bundle zone
      if (getDroppedDirPath(e.dataTransfer)) {
        setError("Use the bundle import zone below for folders.");
        return;
      }
      const { files, readErrors } = await readAllFiles(e.dataTransfer.files);
      if (files.length === 0 && readErrors.length === 0) {
        setError("Could not read the dropped file(s).");
        return;
      }
      try {
        const result =
          files.length > 0 ? await onImportFiles(files) : { succeeded: [], errors: [] };
        const allErrors = [...readErrors, ...result.errors];
        if (allErrors.length > 0) {
          setImportResult({ succeeded: result.succeeded, errors: allErrors });
        } else {
          onClose();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [busy, onImportFiles, onClose],
  );

  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (busy) return;
      if (!e.target.files || e.target.files.length === 0) return;
      setError(null);
      setImportResult(null);
      const { files, readErrors } = await readAllFiles(e.target.files);
      if (files.length === 0 && readErrors.length === 0) {
        setError("Could not read the selected file(s).");
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      try {
        const result =
          files.length > 0 ? await onImportFiles(files) : { succeeded: [], errors: [] };
        const allErrors = [...readErrors, ...result.errors];
        if (allErrors.length > 0) {
          setImportResult({ succeeded: result.succeeded, errors: allErrors });
        } else {
          onClose();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [busy, onImportFiles, onClose],
  );

  // ── Bundle import helper ─────────────────────────────────────────────

  const doBundleImport = useCallback(
    async (dirPath?: string) => {
      setError(null);
      setBundleImporting(true);
      try {
        await onImportBundle(dirPath);
        onClose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // User-initiated dismissals (picker cancel, conflict skip/cancel) — not errors
        const dismissed = (SKILL_IMPORT_DISMISSED as readonly string[]).includes(msg);
        if (!dismissed) {
          setError(msg);
        }
      } finally {
        setBundleImporting(false);
      }
    },
    [onImportBundle, onClose],
  );

  // ── Bundle drop zone handlers ────────────────────────────────────────

  const handleBundleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (busy) return;
      if (e.dataTransfer.types.includes("Files")) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setIsDraggingBundle(true);
      }
    },
    [busy],
  );

  const handleBundleDragLeave = useCallback((e: React.DragEvent) => {
    if (
      e.currentTarget === e.target ||
      !(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))
    ) {
      setIsDraggingBundle(false);
    }
  }, []);

  const handleBundleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingBundle(false);
      setIsDraggingFile(false);
      if (busy) return;

      const dirPath = getDroppedDirPath(e.dataTransfer);
      if (!dirPath) {
        setError("Please drop a folder, not a file.");
        return;
      }
      void doBundleImport(typeof dirPath === "string" ? dirPath : undefined);
    },
    [busy, doBundleImport],
  );

  const handleBundleClick = useCallback(() => {
    if (busy) return;
    void doBundleImport();
  }, [busy, doBundleImport]);

  // ── URL handler ──────────────────────────────────────────────────────

  const handleUrlImport = useCallback(async () => {
    if (busy) return;
    if (!url.trim()) return;
    setError(null);
    try {
      await onUrlImport(url.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [busy, url, onUrlImport, onClose]);

  return (
    <Dialog open={true} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-md!" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{IMPORT_CONFIG.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div
            className="space-y-2 rounded-md px-3 py-2 text-xs"
            data-testid="import-result-summary"
            role="status"
            aria-live="polite"
          >
            {importResult && (
              <>
                <p className="font-medium text-foreground">
                  Imported {importResult.succeeded.length} of{" "}
                  {importResult.succeeded.length + importResult.errors.length} skills
                </p>
                {importResult.succeeded.length > 0 && (
                  <div
                    className="rounded-md bg-green-500/10 px-2 py-1.5 text-green-600 dark:text-green-400"
                    data-testid="import-success-list"
                  >
                    <p className="font-medium">Succeeded:</p>
                    <ul className="ml-4 list-disc">
                      {importResult.succeeded.map((name) => (
                        <li key={name}>{name}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {importResult.errors.length > 0 && (
                  <div
                    className="rounded-md bg-destructive/10 px-2 py-1.5 text-destructive"
                    data-testid="import-error-list"
                  >
                    <p className="font-medium">Failed:</p>
                    <ul className="ml-4 list-disc">
                      {importResult.errors.map((err) => (
                        <li key={err.fileName}>
                          <span className="font-medium">{err.fileName}:</span> {err.error}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {/* Drop zone — skill file */}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            className={cn(
              "h-auto w-full flex-col gap-2 rounded-xl border border-dashed px-4 py-8 text-center whitespace-normal",
              busy
                ? "pointer-events-none opacity-50"
                : isDraggingFile
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-muted-foreground hover:bg-muted/30",
            )}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
          >
            <FileUp className="size-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {isDraggingFile ? "Drop to import" : IMPORT_CONFIG.hint}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">or click to browse</p>
            </div>
          </Button>

          <input
            ref={fileInputRef}
            type="file"
            accept={IMPORT_CONFIG.accept}
            multiple
            className="hidden"
            data-testid="file-input"
            onChange={handleFileInput}
          />

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {/* Drop zone — skill bundle (directory) */}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-testid="bundle-zone"
            aria-describedby="bundle-zone-desc"
            aria-busy={bundleImporting}
            className={cn(
              "h-auto w-full flex-col gap-2 rounded-xl border border-dashed px-4 py-8 text-center whitespace-normal",
              busy
                ? "pointer-events-none opacity-50"
                : isDraggingBundle
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-muted-foreground hover:bg-muted/30",
            )}
            onClick={handleBundleClick}
            onDragOver={handleBundleDragOver}
            onDragLeave={handleBundleDragLeave}
            onDrop={handleBundleDrop}
          >
            {bundleImporting ? (
              <>
                <Loader2 className="size-8 animate-spin text-muted-foreground" />
                <p className="text-sm font-medium text-foreground">Importing bundle...</p>
              </>
            ) : (
              <>
                <FolderOpen className="size-8 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {isDraggingBundle ? "Drop folder to import" : IMPORT_CONFIG.bundleHint}
                  </p>
                </div>
              </>
            )}
            {/* Always rendered so aria-describedby resolves even during import */}
            <p
              id="bundle-zone-desc"
              className={cn("text-xs text-muted-foreground", bundleImporting ? "sr-only" : "mt-1")}
            >
              {IMPORT_CONFIG.bundleDescription}
            </p>
          </Button>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          {/* URL input */}
          <div className={cn("flex gap-2", busy && "pointer-events-none opacity-50")}>
            <div className="relative flex-1">
              <Globe className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8 focus-visible:border-foreground focus-visible:ring-0"
                placeholder={IMPORT_CONFIG.urlPlaceholder}
                disabled={busy}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleUrlImport();
                }}
              />
            </div>
            <Button size="sm" onClick={handleUrlImport} disabled={busy || !url.trim()}>
              Import
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{IMPORT_CONFIG.urlTip}</p>
          <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-200">
            <AlertTriangle className="size-4 text-amber-500" aria-hidden="true" />
            <AlertTitle>Skill import warning</AlertTitle>
            <AlertDescription className="text-xs">
              Only import skills from sources you trust. Imported skills can change how the agent
              behaves.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
