import { useState, type FormEvent } from "react";

import { Input } from "@/components/marshal-ui/input";
import { Button } from "@/components/marshal-ui/marshal-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AccountNameDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  initialName?: string;
  pending: boolean;
  error?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => void;
}

export function AccountNameDialog({
  open,
  title,
  description,
  confirmLabel,
  initialName = "",
  pending,
  error,
  onOpenChange,
  onConfirm,
}: AccountNameDialogProps) {
  const [name, setName] = useState(initialName);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            aria-label="Account name"
            placeholder="Work"
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
