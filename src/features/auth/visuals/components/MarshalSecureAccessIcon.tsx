interface Props {
  size?: number;
}

export function MarshalSecureAccessIcon({ size = 48 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      data-testid="marshal-secure-access-icon"
    >
      <circle cx="24" cy="24" r="9" fill="currentColor" data-testid="marshal-secure-access-fill" />
      <path
        d="M24 6C29.13 6 33.59 7.92 36.84 11.08M42 24C42 28.91 40.24 33.41 37.31 36.9M24 42C18.87 42 14.41 40.08 11.16 36.92M6 24C6 19.09 7.76 14.59 10.69 11.1"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        data-testid="marshal-secure-access-stroke"
      />
      <path
        d="M31.5 16.5L36 12M31.5 31.5L36 36M16.5 31.5L12 36M16.5 16.5L12 12"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        data-testid="marshal-secure-access-stroke"
      />
      <circle cx="24" cy="6" r="3" fill="currentColor" data-testid="marshal-secure-access-fill" />
      <circle cx="42" cy="24" r="3" fill="currentColor" data-testid="marshal-secure-access-fill" />
      <circle cx="24" cy="42" r="3" fill="currentColor" data-testid="marshal-secure-access-fill" />
      <circle cx="6" cy="24" r="3" fill="currentColor" data-testid="marshal-secure-access-fill" />
    </svg>
  );
}
