import { User } from "@/components/icons";
import { Avatar, AvatarFallback } from "@/components/marshal-ui/avatar";
import { cn } from "@/lib/marshal-class-names";

import { pickAvatarColorClasses, getInitials } from "../../conversation-input";

interface PersonAvatarProps {
  email?: string;
  /** Display name used to derive initials. */
  displayName?: string;
  /** Square pixel size of the rendered avatar. */
  size?: number;
  className?: string;
}

const ICON_FRACTION = 0.6;
const INITIALS_FONT_FRACTION = 0.4;

/**
 * Renders colored initials (when a displayName is provided) or a generic User
 * icon, keyed by email for a stable color.
 */
export function PersonAvatar({ email, displayName, size = 32, className }: PersonAvatarProps) {
  const initials = getInitials(displayName);
  const colorClasses = pickAvatarColorClasses(email ?? displayName);

  return (
    <Avatar className={cn("size-auto", className)} style={{ width: size, height: size }}>
      <AvatarFallback
        data-testid="persona-avatar-fallback"
        className={initials ? colorClasses : undefined}
        style={initials ? { fontSize: Math.round(size * INITIALS_FONT_FRACTION) } : undefined}
      >
        {initials ?? <User size={Math.round(size * ICON_FRACTION)} />}
      </AvatarFallback>
    </Avatar>
  );
}
