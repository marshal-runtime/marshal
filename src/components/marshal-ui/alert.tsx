import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/marshal-class-names";

const alertStyle = cva(
  "relative w-full rounded-lg border px-4 py-3 text-sm [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground [&>svg~*]:pl-7",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground",
        destructive:
          "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type AlertProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertStyle>;

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { className, variant, ...props },
  ref,
) {
  return (
    <div ref={ref} role="alert" className={cn(alertStyle({ variant }), className)} {...props} />
  );
});
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  function AlertTitle({ className, ...props }, ref) {
    return (
      <h5
        ref={ref}
        className={cn("mb-1 leading-none font-medium tracking-tight", className)}
        {...props}
      />
    );
  },
);
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function AlertDescription({ className, ...props }, ref) {
  return <div ref={ref} className={cn("text-sm [&_p]:leading-relaxed", className)} {...props} />;
});
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
