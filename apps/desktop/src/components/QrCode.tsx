import { useMemo } from "react";
import { encode } from "uqr";

export function QrCode({
  value,
  size = 208,
  label,
}: {
  value: string;
  size?: number;
  label: string;
}) {
  const { path, dimension } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${String(x)} ${String(y)}h1v1h-1z`;
      });
    });
    return { path: d, dimension: qr.size };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${String(dimension)} ${String(dimension)}`}
      shapeRendering="crispEdges"
      className="rounded-md bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
