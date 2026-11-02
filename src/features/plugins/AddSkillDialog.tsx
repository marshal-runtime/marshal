import { useState } from "react";

import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/marshal-ui/input";
import { Label } from "@/components/marshal-ui/label";
import { Textarea } from "@/components/marshal-ui/textarea";
import { useDiscardGuard } from "@/shared/hooks/useDiscardChangesGuard";

export interface AddSkillDialogProps {
  onSave: (name: string, description: string, instructions: string, displayName?: string) => void;
  onClose: () => void;
  initial?: { name: string; displayName?: string; description: string; instructions: string };
}

export function AddSkillDialog({ onSave, onClose, initial }: AddSkillDialogProps) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");

  const isDirty = isEdit
    ? name !== (initial?.name ?? "") ||
      displayName !== (initial?.displayName ?? "") ||
      description !== (initial?.description ?? "") ||
      instructions !== (initial?.instructions ?? "")
    : !!(name.trim() || displayName.trim() || description.trim() || instructions.trim());
  const isValidName = /^[a-z][a-z0-9-]*$/.test(name) || name === "";
  const canSave = !!name.trim() && isValidName && !!description.trim();
  const { confirmDiscard, handleClose, resetConfirm } = useDiscardGuard(isDirty, onClose);

  return (
    <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent
        className="flex max-h-[85vh] max-w-lg! flex-col overflow-hidden"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Skill" : "Add Skill"}</DialogTitle>
        </DialogHeader>
        <div
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
          onPointerDown={resetConfirm}
        >
          <div className="space-y-1.5">
            <Label htmlFor="skill-name" className="gap-0">
              Name<span className="text-destructive">&nbsp;*</span>{" "}
              <span className="ml-1 font-normal text-muted-foreground/60">(command)</span>
            </Label>
            <Input
              id="skill-name"
              placeholder="my-skill"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              autoFocus={!isEdit}
              disabled={isEdit}
            />
            {name && !isValidName && (
              <p className="text-[11px] text-destructive">
                Only lowercase letters, numbers, and dashes
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-display-name">
              Display Name <span className="font-normal text-muted-foreground/60">(optional)</span>
            </Label>
            <Input
              id="skill-display-name"
              placeholder="My Skill"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoFocus={isEdit}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="skill-desc">Description</Label>
            <Input
              id="skill-desc"
              placeholder="What this skill does..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
            <Label htmlFor="skill-instructions" className="gap-0">
              Instructions<span className="text-destructive">&nbsp;*</span>
            </Label>
            <Textarea
              id="skill-instructions"
              className="min-h-[200px] flex-1 resize-none"
              placeholder="Detailed instructions for the agent when this skill is invoked..."
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant={confirmDiscard ? "destructive" : "ghost"} onClick={handleClose}>
            {confirmDiscard ? "Discard?" : "Cancel"}
          </Button>
          <Button
            onClick={() =>
              onSave(
                name.trim(),
                description.trim(),
                instructions.trim(),
                displayName.trim() || undefined,
              )
            }
            disabled={!canSave}
          >
            {isEdit ? "Save Changes" : "Create Skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
