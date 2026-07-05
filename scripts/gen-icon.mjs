// Generates media/icon.png (128×128 placeholder, patchbay motif) with zero
// image dependencies: raw RGBA → PNG chunks by hand. Run: node scripts/gen-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 128;
const H = 128;
const px = Buffer.alloc(W * H * 4);

const BG = [19, 20, 23];
const SOCKET = [44, 45, 52];
const TEAL = [69, 196, 168];
const ORANGE = [232, 150, 79];

function fill(x0, y0, w, h, [r, g, b]) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
}

fill(0, 0, W, H, BG);

// Two rows of four jacks: sources on top, destinations below.
const JACK = 14;
const cols = [16, 44, 72, 100];
for (const x of cols) fill(x, 22, JACK, JACK, SOCKET);
for (const x of cols) fill(x, 92, JACK, JACK, SOCKET);

// One teal patch cable: col 0 top → col 2 bottom (down, across, down).
const LW = 6;
fill(20, 36, LW, 28, TEAL);
fill(20, 60, 60, LW, TEAL);
fill(74, 60, LW, 32, TEAL);
fill(16, 22, JACK, JACK, TEAL); // lit source jack
fill(72, 92, JACK, JACK, TEAL); // lit destination jack

// One orange cable: col 3 straight down (the "consumed" accent).
fill(104, 36, LW, 56, ORANGE);
fill(100, 22, JACK, JACK, ORANGE);
fill(100, 92, JACK, JACK, ORANGE);

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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../media/icon.png", import.meta.url), png);
console.log("media/icon.png written");
