/* verify the cleaned logo: transparency, kept art, connected components */
const fs = require('fs');
const { PNG } = require('pngjs');
const png = PNG.sync.read(fs.readFileSync('drarefin-logo.png'));
const { width: w, height: h, data } = png;
const px = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
let opaque = 0, semi = 0;
for (let i = 3; i < data.length; i += 4) { if (data[i] === 255) opaque++; else if (data[i] > 0) semi++; }
console.log('opaque=' + opaque + ' semi=' + semi + ' transparent=' + (w * h - opaque - semi));
console.log('corners alpha: ' + [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)].map((p) => p[3]).join(','));
// connected opaque components
const seen = new Uint8Array(w * h);
let comps = 0, sizes = [];
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const idx = y * w + x;
  if (seen[idx] || data[idx * 4 + 3] < 60) continue;
  comps++;
  let size = 0;
  const st = [[x, y]];
  seen[idx] = 1;
  while (st.length) {
    const [cx, cy] = st.pop();
    size++;
    [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]].forEach(([nx, ny]) => {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
      const n = ny * w + nx;
      if (!seen[n] && data[n * 4 + 3] >= 60) { seen[n] = 1; st.push([nx, ny]); }
    });
  }
  sizes.push(size);
}
sizes.sort((a, b) => b - a);
console.log('opaque components: ' + comps + '  top sizes: ' + sizes.slice(0, 6).join(','));
// colour of the biggest component (should be gold-ish, not white tile)
if (sizes.length) {
  const seen2 = new Uint8Array(w * h);
  let best = null, bestN = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const idx = y * w + x;
    if (seen2[idx] || data[idx * 4 + 3] < 60) continue;
    let n = 0, r = 0, g = 0, b = 0;
    const st = [[x, y]];
    seen2[idx] = 1;
    while (st.length) {
      const [cx, cy] = st.pop();
      n++;
      const i = (cy * w + cx) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2];
      [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]].forEach(([nx, ny]) => {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        const m = ny * w + nx;
        if (!seen2[m] && data[m * 4 + 3] >= 60) { seen2[m] = 1; st.push([nx, ny]); }
      });
    }
    if (n > bestN) { bestN = n; best = [Math.round(r / n), Math.round(g / n), Math.round(b / n)]; }
  }
  console.log('largest component: ' + bestN + ' px, avg colour #' + best.map((v) => v.toString(16).padStart(2, '0')).join(''));
}
// scanlines to eyeball shape
for (const yy of [60, 120, 180]) {
  const row = [];
  for (let xx = 0; xx < w; xx += Math.floor(w / 12)) { const p = px(xx, yy); row.push(p[3] === 0 ? '.....' : ('#' + p.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join(''))); }
  console.log('y=' + yy + ': ' + row.join(' '));
}
