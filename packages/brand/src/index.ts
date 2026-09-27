export const brand = {
  name: "Nautilus",
  tagline: "Run coding agents from your phone.",
  description:
    "A private remote workspace for coding agents. Your projects stay on your PC, a cloud runner does the work, and your phone steers it.",
  publisher: "Nautilus",
  copyright: "© 2026 Nautilus",
  colors: {
    night: "#111418",

    slate: "#1f252c",

    pearl: "#ffffff",

    mist: "#c9d3dc",
  },

  background: { light: "#f1f1f1", dark: "#1b1b1b" },
} as const;

export const markSize = 1024;

type Point = readonly [number, number];

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Point, by: number): Point => [a[0] * by, a[1] * by];
const turn = ([x, y]: Point, degrees: number): Point => {
  const angle = (degrees * Math.PI) / 180;
  return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
};
const round = (value: number) => String(Number(value.toFixed(1)));
const area = (polygon: readonly Point[]) =>
  polygon.reduce((sum, [x, y], index) => {
    const [nx, ny] = polygon[(index + 1) % polygon.length] ?? [0, 0];
    return sum + x * ny - nx * y;
  }, 0);

function inset(polygon: readonly Point[], distance: number): Point[] {
  const sign = Math.sign(area(polygon));
  const edges = polygon.map((from, index) => {
    const to = polygon[(index + 1) % polygon.length] ?? from;
    const direction: Point = [to[0] - from[0], to[1] - from[1]];
    const length = Math.hypot(...direction);
    const normal: Point = [(-direction[1] / length) * sign, (direction[0] / length) * sign];
    return { origin: add(from, scale(normal, distance)), direction };
  });
  return edges.map((edge, index) => {
    const previous = edges[(index - 1 + edges.length) % edges.length] ?? edge;
    const [px, py] = previous.direction;
    const [ex, ey] = edge.direction;
    const t =
      ((edge.origin[0] - previous.origin[0]) * ey - (edge.origin[1] - previous.origin[1]) * ex) /
      (px * ey - py * ex);
    return add(previous.origin, scale(previous.direction, t));
  });
}

export function shellMark(size = 640, gap = 30): string {
  const growth = 1.32;
  const steps = 2;
  const living = 3;
  const last = 4 * steps;

  const centers: Point[] = [];
  const directions: Point[] = [];
  let center: Point = [0, 0];
  let direction = turn([1, 0], 250);
  for (let arc = 0; arc < 4 + last / steps + 1; arc++) {
    centers.push(center);
    directions.push(direction);
    const next = turn(direction, 90);
    center = add(center, scale(next, growth ** -arc - growth ** -(arc + 1)));
    direction = next;
  }

  const at = (index: number): Point => {
    const arc = Math.floor(index / steps);
    const along = turn(directions[arc] ?? [1, 0], (90 * (index % steps)) / steps);
    return add(centers[arc] ?? [0, 0], scale(along, growth ** -arc));
  };
  const inner = (index: number) => at(index + 4 * steps);

  const mouth = inner(0);
  const lipEnd = at(0);
  const bulge = add(
    scale(add(mouth, lipEnd), 0.5),
    scale(turn([lipEnd[0] - mouth[0], lipEnd[1] - mouth[1]], -90), 0.5),
  );
  const lip = add(add(scale(mouth, 0.25), scale(bulge, 0.5)), scale(lipEnd, 0.25));

  const chambers: Point[][] = [
    [
      ...Array.from({ length: living + 1 }, (_, index) => at(index)),
      ...Array.from({ length: living + 1 }, (_, index) => inner(living - index)),
      lip,
    ],
  ];
  for (let index = living; index < last - 1; index++) {
    chambers.push([at(index), at(index + 1), inner(index + 1), inner(index)]);
  }
  chambers.push([at(last - 1), at(last), inner(last - 1)]);
  chambers.push(Array.from({ length: 4 * steps }, (_, index) => at(last + index)));

  const points = chambers.flat();
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const fit = size / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const offset: Point = [
    markSize / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * fit,
    markSize / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * fit,
  ];
  return chambers
    .map((chamber) =>
      inset(
        chamber.map((point) => add(offset, scale(point, fit))),
        gap / 2,
      ),
    )
    .map((chamber) => `M${chamber.map((point) => point.map(round).join(" ")).join("L")}Z`)
    .join("");
}
