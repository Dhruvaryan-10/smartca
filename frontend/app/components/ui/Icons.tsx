import type { SVGProps } from "react";

// One small, consistent icon language for the shell: 20x20, 1.5px
// stroke, round caps/joins — no icon library, no emoji.
function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconSummary(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M3 15V9M8 15V5M13 15v-3M17 15V8" />
    </Icon>
  );
}

export function IconLedger(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="4" y="3" width="12" height="14" rx="1.5" />
      <path d="M7 7h6M7 10.5h6M7 14h3" />
    </Icon>
  );
}

export function IconTax(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M6 2.5h6l3 3V17a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 5 17V3a.5.5 0 0 1 .5-.5Z" />
      <path d="M7.5 9.5h5M7.5 12.5h3.5" />
    </Icon>
  );
}

export function IconVault(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <circle cx="10" cy="10" r="2.25" />
      <path d="M10 8v-.75M10 12.75V12M12 10h.75M7.25 10H8" />
    </Icon>
  );
}

export function IconAsk(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M3.5 5.5A1.5 1.5 0 0 1 5 4h10a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 15 13H8l-3.5 3v-3H5a1.5 1.5 0 0 1-1.5-1.5v-6Z" />
    </Icon>
  );
}

export function IconMenu(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
    </Icon>
  );
}

export function IconClose(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M5 5l10 10M15 5L5 15" />
    </Icon>
  );
}

export function IconSun(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="10" cy="10" r="3.25" />
      <path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1 4.7 4.7" />
    </Icon>
  );
}

export function IconMoon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M16 12.2A6.5 6.5 0 0 1 7.8 4 6.5 6.5 0 1 0 16 12.2Z" />
    </Icon>
  );
}

export function IconChevronDown(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M5.5 8l4.5 4.5L14.5 8" />
    </Icon>
  );
}
