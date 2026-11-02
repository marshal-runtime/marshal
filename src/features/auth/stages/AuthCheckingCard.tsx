import { AuthCardShell } from "../AuthCardShell";

export function AuthCheckingCard() {
  return (
    <AuthCardShell ariaLiveLabel="Checking authentication" paddingY="10">
      <div className="flex flex-col items-center gap-4">
        <span
          className="size-7 animate-spin rounded-full border-2 border-border border-t-brand-action"
          aria-hidden="true"
        />
        <p className="text-sm text-muted-foreground">Checking authentication...</p>
      </div>
    </AuthCardShell>
  );
}
