interface MarshalIconProps {
  size?: number;
  className?: string;
}

export function MarshalIcon({ size = 48, className }: MarshalIconProps) {
  return (
    <img
      src="./marshal-icon.svg"
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden
    />
  );
}
