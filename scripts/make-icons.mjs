// Draws the app and tray icons (a woven square) with no image dependencies.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "assets");

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const start = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) raw.set(pixel(x + 0.5, y + 0.5), start + 1 + x * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Tiles of an n-by-n weave: warp tiles stand upright and weft tiles lie across, in a checkerboard. */
function weave(n, first, cell, width, gap) {
  const halfLength = cell - width / 2 - gap;
  const tiles = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const warp = (i + j) % 2 === 0;
      tiles.push({
        warp,
        cx: first + i * cell,
        cy: first + j * cell,
        halfX: warp ? width / 2 : halfLength,
        halfY: warp ? halfLength : width / 2,
      });
    }
  }
  return tiles;
}

/** Signed distance to the nearest warp or weft tile; negative means inside. */
function weaveDistance(tiles, warp, px, py, radius) {
  let nearest = Infinity;
  for (const tile of tiles) {
    if (tile.warp !== warp) continue;
    const qx = Math.abs(px - tile.cx) - tile.halfX + radius;
    const qy = Math.abs(py - tile.cy) - tile.halfY + radius;
    const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    nearest = Math.min(nearest, distance);
  }
  return nearest;
}

const APP_WEAVE = weave(3, 20, 12, 8.6, 1.2);
const BAR_WEAVE = weave(2, 5, 8, 5.6, 1);

const GRAPHITE = [43, 40, 37];
const BONE = [240, 238, 235];
const AMBER = [245, 174, 57];

function coverage(distance, size) {
  return Math.max(0, Math.min(1, 0.5 - distance * size));
}

function roundedSquare(x, y) {
  const margin = 0.09;
  const radius = 0.19;
  const half = 0.5 - margin - radius;
  const qx = Math.abs(x - 0.5) - half;
  const qy = Math.abs(y - 0.5) - half;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function appIcon(size) {
  return png(size, (x, y) => {
    const u = x / size;
    const v = y / size;
    const base = coverage(roundedSquare(u, v), size);
    // The weave is drawn on a 64-unit grid and sits inside the tile at 95% scale.
    const scale = 0.95 / 64;
    const px = (u - 0.5) / scale + 32;
    const py = (v - 0.5) / scale + 32;
    const warp = coverage(weaveDistance(APP_WEAVE, true, px, py, 1.4) * scale, size);
    const weft = coverage(weaveDistance(APP_WEAVE, false, px, py, 1.4) * scale, size);
    const mix = (i) => Math.round(GRAPHITE[i] + (BONE[i] - GRAPHITE[i]) * warp + (AMBER[i] - GRAPHITE[i]) * weft);
    return [mix(0), mix(1), mix(2), Math.round(base * 255)];
  });
}

/** Menu bar mark: the upright threads follow the bar and the crossing threads carry the status color. */
function statusIcon(size, rgb, status) {
  const scale = 0.86 / 18;
  return png(size, (x, y) => {
    const px = (x / size - 0.5) / scale + 9;
    const py = (y / size - 0.5) / scale + 9;
    const warp = coverage(weaveDistance(BAR_WEAVE, true, px, py, 1) * scale, size);
    const weft = coverage(weaveDistance(BAR_WEAVE, false, px, py, 1) * scale, size);
    const color = weft > warp ? status : rgb;
    return [...color, Math.round(Math.max(warp, weft) * 255)];
  });
}

mkdirSync(OUT, { recursive: true });
const BARS = { dark: [245, 245, 242], light: [28, 32, 30] };
const DOTS = { on: [52, 199, 89], paused: [255, 69, 58] };
for (const [bar, rgb] of Object.entries(BARS)) {
  for (const [status, dot] of Object.entries(DOTS)) {
    writeFileSync(join(OUT, `tray-${bar}-${status}.png`), statusIcon(22, rgb, dot));
    writeFileSync(join(OUT, `tray-${bar}-${status}@2x.png`), statusIcon(44, rgb, dot));
  }
}
writeFileSync(join(OUT, "icon.png"), appIcon(1024));
