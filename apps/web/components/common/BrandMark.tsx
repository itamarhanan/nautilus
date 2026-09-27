import { brand, markSize, shellMark } from "@nautilus/brand";

const shell = shellMark();
const { night, slate, pearl, mist } = brand.colors;

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(markSize)} ${String(markSize)}`}
      aria-hidden="true"
      className="shrink-0"
    >
      <defs>
        <linearGradient id="nautilus-mark-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={night} />
          <stop offset="1" stopColor={slate} />
        </linearGradient>
        <linearGradient id="nautilus-mark-shell" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={pearl} />
          <stop offset="1" stopColor={mist} />
        </linearGradient>
      </defs>
      <rect width={markSize} height={markSize} rx={232} fill="url(#nautilus-mark-tile)" />
      <path d={shell} fill="url(#nautilus-mark-shell)" />
    </svg>
  );
}
