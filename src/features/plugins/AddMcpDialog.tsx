import { defaultMcpEnvFileToken, managedMcpEnvServerKey } from "@common/marshal-mcp-env-file";
import { toMcpServerKey } from "@common/mcp-server-key-normalization";
import { useState } from "react";

import { AlertTriangle } from "@/components/icons";
import { Alert, AlertDescription, AlertTitle } from "@/components/marshal-ui/alert";
import { Input } from "@/components/marshal-ui/input";
import { Label } from "@/components/marshal-ui/label";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/marshal-ui/marshal-collapsible";
import { RadioGroup, RadioGroupItem } from "@/components/marshal-ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDiscardGuard } from "@/shared/hooks/useDiscardChangesGuard";

/** Default `envFile` value for a new MCP server. Resolves at spawn time (via
 *  `resolveMcpEnv` in main) to `~/.marshal/marshal-mcp-env/<key>.env` — colocated with
 *  `marshal-mcp-servers.json`, never written into the user's workspace folder where it
 *  could end up in a cloud-sync client folder or collide with the user's own `.env`. */
function defaultEnvFileFor(name: string): string {
  return defaultMcpEnvFileToken(toMcpServerKey(name));
}

export interface AddMcpDialogProps {
  name: string;
  url: string;
  command: string;
  bearerToken: string;
  timeoutSeconds: string;
  envFile: string;
  mode: "url" | "command";
  transport: "http" | "sse";
  onNameChange: (v: string) => void;
  onUrlChange: (v: string) => void;
  onCommandChange: (v: string) => void;
  onBearerTokenChange: (v: string) => void;
  onTimeoutSecondsChange: (v: string) => void;
  onEnvFileChange: (v: string) => void;
  onModeChange: (v: "url" | "command") => void;
  onTransportChange: (v: "http" | "sse") => void;
  onSave: () => Promise<void>;
  onClose: () => void;
  canSave: boolean;
}

export function AddMcpDialog({
  name,
  url,
  command,
  bearerToken,
  timeoutSeconds,
  envFile,
  mode,
  transport,
  onNameChange,
  onUrlChange,
  onCommandChange,
  onBearerTokenChange,
  onTimeoutSecondsChange,
  onEnvFileChange,
  onModeChange,
  onTransportChange,
  onSave,
  onClose,
  canSave,
}: AddMcpDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [envOpen, setEnvOpen] = useState(false);
  const [envStatus, setEnvStatus] = useState<string | null>(null);

  // Effective envFile shown in the path input: the typed value wins; otherwise
  // we display the auto-default derived from the server name. Computing during
  // render (rather than pushing it back to parent via an effect) avoids the
  // derived-state anti-pattern where a setState-in-effect re-fires on every
  // keystroke. The parent only learns about the path when the user actually
  // types in the input or hits Add.
  const effectiveEnvFile = envFile.trim() || defaultEnvFileFor(name);
  const editorServerKey = managedMcpEnvServerKey(effectiveEnvFile);
  const editorFileName = editorServerKey ? `${editorServerKey}.env` : ".env";

  const isDirty = !!(
    name.trim() ||
    url.trim() ||
    command.trim() ||
    bearerToken.trim() ||
    timeoutSeconds.trim() ||
    envFile.trim()
  );
  const { confirmDiscard, handleClose, resetConfirm } = useDiscardGuard(isDirty, onClose);

  const openManagedEnv = async (target: "default" | "reveal") => {
    if (!window.mcpsAPI || !editorServerKey) return;
    setEnvStatus(null);
    // Commit the auto-default to the parent on first open so the saved server
    // config carries the path the user just opened. No-op if the user already
    // typed something.
    if (!envFile.trim() && effectiveEnvFile) onEnvFileChange(effectiveEnvFile);
    const opened = await window.mcpsAPI.openEnvFile(editorServerKey, target);
    if (opened?.success) {
      if (target === "default" && opened.revealed) {
        setEnvStatus(`No default app for ${editorFileName} — revealed in file manager instead`);
      }
      return;
    }
    setEnvStatus(opened?.error ?? `Could not open ${editorFileName}`);
  };

  const handleSave = async () => {
    setError(null);
    try {
      await onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-[490px]!" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Add MCP Server</DialogTitle>
          <DialogDescription className="sr-only">
            Configure a custom Model Context Protocol server: pick command or URL transport, set an
            optional envFile for secrets, and discover its tools.
          </DialogDescription>
        </DialogHeader>
        <div
          className="min-w-0 space-y-3"
          onPointerDown={() => {
            resetConfirm();
            setError(null);
          }}
        >
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          <Input
            className="rounded-xl"
            placeholder="Server name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant={mode === "url" ? "default" : "ghost"}
              size="sm"
              className={`rounded-xl ${mode === "url" ? "font-semibold" : ""}`}
              onClick={() => onModeChange("url")}
            >
              Remote / Local URL
            </Button>
            <Button
              variant={mode === "command" ? "default" : "ghost"}
              size="sm"
              className={`rounded-xl ${mode === "command" ? "font-semibold" : ""}`}
              onClick={() => onModeChange("command")}
            >
              Command
            </Button>
          </div>
          {mode === "url" ? (
            <>
              <Input
                className="rounded-xl"
                placeholder="https://... or http://localhost:..."
                value={url}
                onChange={(e) => onUrlChange(e.target.value)}
              />
              <Input
                className="rounded-xl"
                type="password"
                placeholder="Bearer token (optional)"
                value={bearerToken}
                onChange={(e) => onBearerTokenChange(e.target.value)}
              />
              <Collapsible className="text-xs">
                <CollapsibleTrigger className="cursor-pointer text-muted-foreground">
                  Advanced
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 space-y-1.5">
                  <Label className="text-xs">Transport</Label>
                  <RadioGroup
                    value={transport}
                    onValueChange={(v) => {
                      if (v === "http" || v === "sse") onTransportChange(v);
                    }}
                    className="gap-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem
                        value="http"
                        id="transport-http"
                        data-testid="add-mcp-transport-http"
                      />
                      <Label htmlFor="transport-http" className="font-normal">
                        HTTP (streamable, default)
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem
                        value="sse"
                        id="transport-sse"
                        data-testid="add-mcp-transport-sse"
                      />
                      <Label htmlFor="transport-sse" className="font-normal">
                        SSE (legacy)
                      </Label>
                    </div>
                  </RadioGroup>
                </CollapsibleContent>
              </Collapsible>
            </>
          ) : (
            <>
              <Input
                className="rounded-xl"
                placeholder="npx -y @my-org/mcp-server"
                value={command}
                onChange={(e) => onCommandChange(e.target.value)}
              />
              <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-200">
                <AlertTriangle className="size-4 text-amber-500" aria-hidden="true" />
                <AlertTitle>Local command warning</AlertTitle>
                <AlertDescription className="text-xs">
                  Command MCP servers run a local process on your computer. Only add commands from
                  sources you trust. A malicious command can read files, access credentials
                  available to your account, or run other programs.
                </AlertDescription>
              </Alert>
              <Collapsible className="text-xs" open={envOpen} onOpenChange={setEnvOpen}>
                <CollapsibleTrigger className="cursor-pointer text-muted-foreground">
                  Environment variables (API keys, secrets)
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Secrets file location</Label>
                    <Input
                      className="rounded-xl font-mono text-xs"
                      placeholder={defaultEnvFileFor(name) || "${mcpEnvDir}/yourserver.env"}
                      spellCheck={false}
                      value={envFile}
                      onChange={(e) => onEnvFileChange(e.target.value)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      <span className="font-mono">${"{mcpEnvDir}"}</span> resolves to your Marshal
                      app-data folder (
                      <span className="font-mono">~/.marshal/marshal-mcp-env/</span>) — outside your
                      workspace, so secrets don't end up in cloud-sync folders. Edit the file in
                      your own editor (Marshal never reads or writes the secrets body itself).
                    </p>
                  </div>
                  {editorServerKey ? (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                        {envStatus ?? `Opens ${editorFileName} in your editor.`}
                      </p>
                      <div className="flex shrink-0 flex-wrap items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => void openManagedEnv("default")}
                          title="Open in your default editor (creates the file if missing)"
                        >
                          Open
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => void openManagedEnv("reveal")}
                          title="Reveal in Finder / Explorer"
                        >
                          Reveal
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Open/Reveal shortcuts work only for{" "}
                      <span className="font-mono">${"{mcpEnvDir}"}/&lt;name&gt;.env</span> paths.
                      Custom paths (e.g.{" "}
                      <span className="font-mono">${"{workspaceFolder}"}/.env</span>) are read by
                      the MCP server at runtime — edit them in your own editor.
                    </p>
                  )}
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
          <Input
            className="rounded-xl"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            placeholder="Tool-call timeout in seconds (optional, default ~60)"
            value={timeoutSeconds}
            onChange={(e) => onTimeoutSecondsChange(e.target.value)}
          />
        </div>
        <DialogFooter className="justify-end gap-3">
          <Button
            variant={confirmDiscard ? "destructive" : "outline"}
            className="rounded-xl"
            onClick={handleClose}
          >
            {confirmDiscard ? "Discard?" : "Cancel"}
          </Button>
          <Button
            className="rounded-xl bg-brand-action text-brand-action-fg hover:bg-brand-action-hover"
            onClick={handleSave}
            disabled={!canSave}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
