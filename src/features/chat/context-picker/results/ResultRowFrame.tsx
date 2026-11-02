import type { ReactNode } from "react";

interface ResultRowFrameProps {
  children: ReactNode;
  className?: string;
}

export function ResultRowFrame({ children, className }: ResultRowFrameProps) {
  return <div className={`min-w-0 flex-1 ${className ?? ""}`}>{children}</div>;
}
