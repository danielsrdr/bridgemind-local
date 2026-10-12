// Generates electron/icon.ico (16–256 px, anti-aliased) with no dependencies: purple tile, a white "bridge" arc linking two agent nodes.
import { writeFileSync } from 'node:fs';

function render(S) {
  const px = Buffer.alloc(S * S * 4), ss = 4; // 4x4 supersampling
  const r = S * 0.22, inTile = (x, y) => {
    const dx = Math.max(r - x, x - (S - r), 0), dy = Math.max(r - y, y - (S - r), 0);
    return dx * dx + dy * dy <= r * r;
  };
  const cx = S / 2, cy = S * 0.78, R = S * 0.3, w = Math.max(S * 0.085, 1.2), node = S * 0.095;
  const ax = cx - R, bx = cx + R;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let a = 0, wr = 0, wg = 0, wb = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const X = x + (sx + 0.5) / ss, Y = y + (sy + 0.5) / ss;
      if (!inTile(X, Y)) continue;
      a++;
      const t = (X + Y) / (2 * S); // gradient #8b6dff -> #5a3df0
      let c = [139 - 49 * t, 109 - 48 * t, 255 - 15 * t];
      const d = Math.hypot(X - cx, Y - cy);
      const onArc = Math.abs(d - R) < w / 2 && Y < cy;
      const onNode = Math.hypot(X - ax, Y - cy) < node || Math.hypot(X - bx, Y - cy) < node || Math.hypot(X - cx, Y - (cy - R)) < node * 0.8;
      if (onArc || onNode) c = [255, 255, 255];
      wr += c[0]; wg += c[1]; wb += c[2];
    }
    const i = ((S - 1 - y) * S + x) * 4; // BMP rows bottom-up, BGRA
    if (a) { px[i] = wb / a; px[i + 1] = wg / a; px[i + 2] = wr / a; px[i + 3] = (255 * a) / (ss * ss); }
  }
  const bih = Buffer.alloc(40);
  bih.writeUInt32LE(40, 0); bih.writeInt32LE(S, 4); bih.writeInt32LE(S * 2, 8); bih.writeUInt16LE(1, 12); bih.writeUInt16LE(32, 14);
  return Buffer.concat([bih, px, Buffer.alloc(Math.ceil(S / 32) * 4 * S)]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256], imgs = sizes.map(render);
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = head.length;
sizes.forEach((s, k) => {
  const e = 6 + 16 * k;
  head[e] = s % 256; head[e + 1] = s % 256; head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(imgs[k].length, e + 8); head.writeUInt32LE(off, e + 12); off += imgs[k].length;
});
writeFileSync(new URL('../electron/icon.ico', import.meta.url), Buffer.concat([head, ...imgs]));
console.log('electron/icon.ico written');
