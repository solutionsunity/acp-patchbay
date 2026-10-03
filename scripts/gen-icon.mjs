// Generates the brand mark: media/icon.png (256×256 Marketplace tile, the mark
// filled white on a gradient) and media/patchbay.svg (activity-bar and view
// glyph). Zero image dependencies: the PNG is the contours flattened and
// supersampled, then PNG chunks by hand. Run: node scripts/gen-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

// The mark on a 128-unit grid. A chat bubble with a socket bitten out of its
// right rim and the AI spark plugged into it; the tail is a triangle merged
// into the bubble.
const MARK = {
  bubble: { cx: 58, cy: 60, r: 32 },
  socket: { cx: 92, cy: 60, r: 17 },
  tail: [[36, 80], [26, 100], [50, 88]],
  spark: [92, 60, 13],
};
const DOTS = [[40, 60], [52, 60], [64, 60]];
const DOT_R = 4.5;
const SMALL_SPARK = [104, 28, 7];
const TILE = { x: 8, y: 8, size: 112, rx: 28, from: [0xa3, 0x44, 0x93], to: [0x1c, 0x82, 0xec] };

// The glyph is the mark redrawn for 16–24px on the codicon grid: 24 units, a
// 1.5 stroke on these centerlines, the bubble's outer edge on whole pixels.
// Only the bubble and the plugged-in spark: the dots and the small spark turn
// to noise at that size. VS Code uses it as a mask, so only its shape counts.
const GLYPH = {
  bubble: { cx: 10, cy: 11, r: 8.25 },
  socket: { cx: 18.5, cy: 11, r: 5.75 },
  tail: [[5, 16], [1.75, 22.25], [9, 19]],
  spark: [18.5, 11, 4.25],
  stroke: 1.5,
};

// A contour is a start point plus segments: ["L", x, y], ["C", x1, y1, x2, y2,
// x, y], or ["A", cx, cy, r, a0, a1] (arc from angle a0 to a1). Filled nonzero:
// the silhouette winds one way, the dots the other, so on the tile they punch
// holes.
const at = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

// Where segment a→b crosses circle c.
function crossing([ax, ay], [bx, by], { cx, cy, r }) {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const s = Math.sqrt(b * b - 4 * a * (fx * fx + fy * fy - r * r));
  const t = [(-b - s) / (2 * a), (-b + s) / (2 * a)].find((t) => t >= 0 && t <= 1);
  return [ax + t * dx, ay + t * dy];
}

// Bubble and tail as one outline: around the bubble from the socket's top edge,
// out along the tail, back onto the bubble, then in along the socket.
function silhouette({ bubble, socket, tail }) {
  const { cx, cy, r } = bubble;
  const d = socket.cx - cx;
  const a = (d * d + r * r - socket.r * socket.r) / (2 * d);
  const h = Math.sqrt(r * r - a * a);
  const top = Math.atan2(-h, a);
  const rim = Math.atan2(h, a - d);
  const out = crossing(tail[0], tail[1], bubble);
  const back = crossing(tail[1], tail[2], bubble);
  const angle = ([x, y]) => Math.atan2(y - cy, x - cx) - 2 * Math.PI;
  return {
    start: at(cx, cy, r, top),
    segs: [
      ["A", cx, cy, r, top, angle(out)],
      ["L", ...tail[1]],
      ["L", ...back],
      ["A", cx, cy, r, angle(back), -top - 2 * Math.PI],
      ["A", socket.cx, socket.cy, socket.r, rim, 2 * Math.PI - rim],
    ],
  };
}

const dot = ([cx, cy], r) => ({
  start: at(cx, cy, r, 0),
  segs: [["A", cx, cy, r, 0, Math.PI], ["A", cx, cy, r, Math.PI, 2 * Math.PI]],
});

function spark([cx, cy, r]) {
  const k = r * 0.1;
  const m = r * 0.3;
  return {
    start: [cx, cy - r],
    segs: [
      ["C", cx + k, cy - m, cx + m, cy - k, cx + r, cy],
      ["C", cx + m, cy + k, cx + k, cy + m, cx, cy + r],
      ["C", cx - k, cy + m, cx - m, cy + k, cx - r, cy],
      ["C", cx - m, cy - k, cx - k, cy - m, cx, cy - r],
    ],
  };
}

const TILE_MARK = [silhouette(MARK), ...DOTS.map((c) => dot(c, DOT_R)), spark(MARK.spark), spark(SMALL_SPARK)];

const n = (v) => +v.toFixed(2);

function toPath(contours) {
  return contours
    .map(({ start, segs }) => {
      let d = `M${n(start[0])} ${n(start[1])}`;
      for (const [op, ...v] of segs) {
        if (op === "A") {
          const [cx, cy, r, a0, a1] = v;
          const [x, y] = at(cx, cy, r, a1);
          const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
          d += `A${n(r)} ${n(r)} 0 ${large} ${a1 > a0 ? 1 : 0} ${n(x)} ${n(y)}`;
        } else d += op + v.map(n).join(" ");
      }
      return d + "Z";
    })
    .join("");
}

function flatten({ start, segs }) {
  const pts = [start];
  for (const [op, ...v] of segs) {
    const [x0, y0] = pts[pts.length - 1];
    if (op === "L") pts.push(v);
    if (op === "C") {
      for (let i = 1; i <= 16; i++) {
        const t = i / 16;
        const u = 1 - t;
        const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        pts.push([
          b[0] * x0 + b[1] * v[0] + b[2] * v[2] + b[3] * v[4],
          b[0] * y0 + b[1] * v[1] + b[2] * v[3] + b[3] * v[5],
        ]);
      }
    }
    if (op === "A") {
      const [cx, cy, r, a0, a1] = v;
      const steps = Math.ceil((Math.abs(a1 - a0) * r) / 0.5);
      for (let i = 1; i <= steps; i++) pts.push(at(cx, cy, r, a0 + ((a1 - a0) * i) / steps));
    }
  }
  return pts;
}

// Packed coordinates plus a bounding box, so a sample outside it costs nothing.
function edges(pts) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return { xy: Float64Array.from(pts.flat()), box };
}

function winding(x, y, { xy, box }) {
  if (x < box[0] || y < box[1] || x > box[2] || y > box[3]) return 0;
  let w = 0;
  for (let i = 0, j = xy.length - 2; i < xy.length; j = i, i += 2) {
    const xa = xy[j];
    const ya = xy[j + 1];
    const xb = xy[i];
    const yb = xy[i + 1];
    const cross = (xb - xa) * (y - ya) - (x - xa) * (yb - ya);
    if (ya <= y && yb > y && cross > 0) w++;
    if (ya > y && yb <= y && cross < 0) w--;
  }
  return w;
}

function inTile(x, y) {
  const { x: x0, y: y0, size, rx } = TILE;
  const x1 = x0 + size;
  const y1 = y0 + size;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + rx - x, 0, x - (x1 - rx));
  const dy = Math.max(y0 + rx - y, 0, y - (y1 - rx));
  return dx * dx + dy * dy <= rx * rx;
}

function renderTile(size, ss = 4) {
  const polys = TILE_MARK.map((c) => edges(flatten(c)));
  const px = Buffer.alloc(size * size * 4);
  const k = 128 / size;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let tile = 0;
      let ink = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (pxl + (sx + 0.5) / ss) * k;
          const y = (py + (sy + 0.5) / ss) * k;
          if (!inTile(x, y)) continue;
          tile++;
          let w = 0;
          for (const p of polys) w += winding(x, y, p);
          if (w !== 0) ink++;
        }
      }
      if (!tile) continue;
      const t = Math.min(1, Math.max(0, ((pxl + 0.5) * k + (py + 0.5) * k - 2 * TILE.x) / (2 * TILE.size)));
      const white = ink / tile;
      const i = (py * size + pxl) * 4;
      for (let c = 0; c < 3; c++) {
        const grad = TILE.from[c] + (TILE.to[c] - TILE.from[c]) * t;
        px[i + c] = Math.round(grad + (255 - grad) * white);
      }
      px[i + 3] = Math.round((255 * tile) / (ss * ss));
    }
  }
  return px;
}

function glyphSVG() {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<path d="${toPath([silhouette(GLYPH)])}" fill="none" stroke="currentColor" stroke-width="${GLYPH.stroke}" stroke-linejoin="round"/>` +
    `<path fill="currentColor" d="${toPath([spark(GLYPH.spark)])}"/></svg>\n`
  );
}

// PNG encode
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SIZE = 256;
writeFileSync(new URL("../media/icon.png", import.meta.url), encodePNG(renderTile(SIZE), SIZE));
writeFileSync(new URL("../media/patchbay.svg", import.meta.url), glyphSVG());
console.log("media/icon.png + media/patchbay.svg written");
