/* eslint-disable better-tailwindcss/no-unknown-classes -- Remote styles live in remote.css. */
import { Folder, ChevronsUpDown } from "../components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

export function ProjectPicker({
  workspaceName,
  workspaces,
  disabled,
  locked,
  onSelect,
}: {
  workspaceName?: string;
  workspaces: string[];
  disabled: boolean;
  locked: boolean;
  onSelect: (workspaceName?: string) => void;
}) {
  const label = workspaceName || "General";
  return (
    <div className="remote-composer-project">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Project: ${label}`}
            disabled={disabled || locked}
            title={
              locked
                ? "This conversation stays in its project. Start a new chat to choose another."
                : "Choose project"
            }
          >
            <Folder size={15} aria-hidden="true" />
            <span>{label}</span>
            {!locked && <ChevronsUpDown size={14} aria-hidden="true" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="max-h-64 w-64 overflow-y-auto">
          <DropdownMenuRadioGroup
            value={workspaceName ? `project:${workspaceName}` : "general"}
            onValueChange={(value) => onSelect(value === "general" ? undefined : value.slice(8))}
          >
            <DropdownMenuRadioItem value="general">General</DropdownMenuRadioItem>
            {workspaces.map((name) => (
              <DropdownMenuRadioItem value={`project:${name}`} key={name}>
                {name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
