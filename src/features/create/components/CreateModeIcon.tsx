import { useId } from "react";

interface CreateModeIconProps {
  size?: number;
  id?: string;
  className?: string;
}

export function CreateModeIcon({ size = 20, id, className }: CreateModeIconProps) {
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "-");
  const prefix = id ?? `cmg-${instanceId}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <defs>
        <linearGradient
          id={`${prefix}-core`}
          x1="4"
          y1="20"
          x2="20"
          y2="4"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#2563eb" />
          <stop offset="0.5" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
        <linearGradient
          id={`${prefix}-orbit`}
          x1="16"
          y1="3"
          x2="22"
          y2="10"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#f9a8d4" />
          <stop offset="1" stopColor="#67e8f9" />
        </linearGradient>
      </defs>
      <path
        d="M5 3.75A1.75 1.75 0 0 1 6.75 2h6.5L19 7.75v12.5A1.75 1.75 0 0 1 17.25 22h-10.5A1.75 1.75 0 0 1 5 20.25V3.75Z"
        fill={`url(#${prefix}-core)`}
      />
      <path
        d="M13 2v5.25h5.5"
        stroke="white"
        strokeOpacity=".7"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M8.25 12h7.5M8.25 15.25h5"
        stroke="white"
        strokeOpacity=".6"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path
        d="m20 2 .62 2.38L23 5l-2.38.62L20 8l-.62-2.38L17 5l2.38-.62L20 2Z"
        fill={`url(#${prefix}-orbit)`}
      />
      <path
        d="m16 10 .35 1.15 1.15.35-1.15.35L16 13l-.35-1.15-1.15-.35 1.15-.35L16 10Z"
        fill={`url(#${prefix}-orbit)`}
      />
    </svg>
  );
}
