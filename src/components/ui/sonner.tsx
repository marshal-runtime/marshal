import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "@/components/icons";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useDocumentTheme } from "@/shared/hooks/useTheme";

const toasterStyle: Record<string, string> = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--border-radius": "var(--radius)",
};

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useDocumentTheme();

  return (
    <Sonner
      theme={theme}
      className="group"
      closeButton
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={toasterStyle}
      {...props}
    />
  );
};

export { Toaster };
