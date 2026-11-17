// In-browser photo checks (OpenCV-style image math, no library needed).
// - Sharpness: variance of the Laplacian, measured on the sharpest tiles so a
//   smooth marble background doesn't count against a crisp set.
// - Glare: share of blown-out highlight pixels in the middle of the frame.
// - Exposure: brightness histogram (mean plus clipped shadows/highlights).
// - Near-duplicates: 64-bit difference hash (dHash), Hamming distance.
// Photos that fail hard are dropped before any model call.
// Nothing here changes the photo except resizing it for upload.

const ANALYZE_SIZE = 512;
const UPLOAD_SIZE = 1600;

export const LIMITS = {
  blurDrop: 18,      // Laplacian variance (sharpest tiles) below this = too blurry
  glareDrop: 0.10,   // >10% blown pixels in the center = heavy glare
  darkDrop: 40,      // mean brightness
  brightDrop: 235,
  dupDistance: 10,   // dHash bits
};

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

async function loadBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

function draw(bitmap, maxSide) {
  const w0 = bitmap.width, h0 = bitmap.height;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { canvas: c, ctx, w, h };
}

function dHash(bitmap) {
  const c = document.createElement('canvas');
  c.width = 9; c.height = 8;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bitmap, 0, 0, 9, 8);
  const d = x.getImageData(0, 0, 9, 8).data;
  const g = [];
  for (let i = 0; i < 72; i++) g.push(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
  let bits = '';
  for (let y = 0; y < 8; y++) for (let xx = 0; xx < 8; xx++) bits += g[y * 9 + xx] > g[y * 9 + xx + 1] ? '1' : '0';
  return bits;
}

export function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

const HUES = [
  [15, 'red'], [40, 'orange'], [65, 'gold'], [160, 'green'], [200, 'teal'], [255, 'blue'], [290, 'purple'], [335, 'pink'], [360, 'red'],
];
function colorName(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2 / 255;
  const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
  if (s < 0.18) return l > 0.8 ? 'white' : l < 0.2 ? 'black' : l > 0.55 ? 'nude' : 'gray';
  let h;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  if (h < 40 && l > 0.6 && s < 0.5) return 'nude';
  return HUES.find(([lim]) => h < lim)[1];
}

export async function analyzeFile(file, id) {
  const bitmap = await loadBitmap(file);
  const { ctx, w, h } = draw(bitmap, ANALYZE_SIZE);
  const px = ctx.getImageData(0, 0, w, h).data;

  const gray = new Float32Array(w * h);
  let sum = 0, sumWarm = 0, dark = 0, blown = 0;
  const hist = new Array(16).fill(0);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[j] = y; sum += y; sumWarm += r - b;
    hist[Math.min(15, y >> 4)]++;
    if (y < 12) dark++;
    if (r >= 250 && g >= 250 && b >= 250) blown++;
  }
  const n = w * h;
  const mean = sum / n;

  // Laplacian per tile; edge density in center vs border.
  const TILES = 8;
  const tw = Math.floor(w / TILES), th = Math.floor(h / TILES);
  const tileVar = [];
  const bx0 = Math.round(w * 0.15), bx1 = Math.round(w * 0.85), by0 = Math.round(h * 0.15), by1 = Math.round(h * 0.85);
  const cx0 = Math.round(w * 0.2), cx1 = Math.round(w * 0.8), cy0 = Math.round(h * 0.2), cy1 = Math.round(h * 0.8);
  let borderEdge = 0, borderN = 0, centerEdge = 0, centerN = 0, centerBlown = 0;
  let cr = 0, cg = 0, cb = 0, cn = 0;
  for (let ty = 0; ty < TILES; ty++) {
    for (let tx = 0; tx < TILES; tx++) {
      let s1 = 0, s2 = 0, m = 0;
      for (let y = Math.max(1, ty * th); y < Math.min(h - 1, (ty + 1) * th); y++) {
        for (let x = Math.max(1, tx * tw); x < Math.min(w - 1, (tx + 1) * tw); x++) {
          const k = y * w + x;
          const lap = gray[k - 1] + gray[k + 1] + gray[k - w] + gray[k + w] - 4 * gray[k];
          s1 += lap; s2 += lap * lap; m++;
          const grad = Math.abs(gray[k + 1] - gray[k - 1]) + Math.abs(gray[k + w] - gray[k - w]);
          const edge = grad > 40 ? 1 : 0;
          const inCenter = x >= cx0 && x < cx1 && y >= cy0 && y < cy1;
          if (x < bx0 || x >= bx1 || y < by0 || y >= by1) { borderEdge += edge; borderN++; }
          if (inCenter) {
            centerEdge += edge; centerN++;
            const p = k * 4;
            if (px[p] >= 250 && px[p + 1] >= 250 && px[p + 2] >= 250) centerBlown++;
            cr += px[p]; cg += px[p + 1]; cb += px[p + 2]; cn++;
          }
        }
      }
      if (m) tileVar.push(s2 / m - (s1 / m) ** 2);
    }
  }
  tileVar.sort((a, b) => b - a);
  const top = tileVar.slice(0, Math.max(3, Math.round(tileVar.length * 0.15)));
  const lapVar = top.reduce((a, b) => a + b, 0) / top.length;

  const glareFrac = centerN ? centerBlown / centerN : blown / n;
  const darkFrac = dark / n;

  const checks = {
    // log scale: variance 18 → ~0, 400 → 100
    sharpness: clamp(((Math.log10(Math.max(lapVar, 1)) - Math.log10(LIMITS.blurDrop)) / (Math.log10(400) - Math.log10(LIMITS.blurDrop))) * 100),
    glare: clamp(100 - glareFrac * 100 * 9),
    // Cream/white-fur house style is bright on purpose, so only penalize the extremes.
    exposure: clamp(100 - Math.max(0, 85 - mean) * 1.6 - Math.max(0, mean - 215) * 2.5 - darkFrac * 250 - (blown / n) * 150),
  };

  let dropped = null;
  if (lapVar < LIMITS.blurDrop) dropped = 'Too blurry, skipped';
  else if (glareFrac > LIMITS.glareDrop) dropped = 'Heavy glare, skipped';
  else if (mean < LIMITS.darkDrop || (checks.exposure < 10 && mean < 150)) dropped = 'Too dark, skipped';
  else if (mean > LIMITS.brightDrop) dropped = 'Too bright, skipped';

  const reasons = [];
  reasons.push(checks.sharpness >= 70 ? 'sharp' : checks.sharpness >= 40 ? 'a little soft' : 'soft focus');
  reasons.push(checks.glare >= 85 ? 'no glare' : 'some shine spots');
  if (checks.exposure < 60) reasons.push(mean < 150 ? 'a bit dark' : 'a bit bright');

  // Upload copy: resized only.
  const up = draw(bitmap, UPLOAD_SIZE);
  const dataUrl = up.canvas.toDataURL('image/jpeg', 0.9);
  const thumbUrl = draw(bitmap, 360).canvas.toDataURL('image/jpeg', 0.8);

  const hash = dHash(bitmap);
  if (bitmap.close) bitmap.close();

  const pixelScore = Math.round((checks.sharpness * 2 + checks.glare + checks.exposure) / 4);
  return {
    id, name: file.name, dataUrl, thumbUrl, width: up.w, height: up.h,
    checks, pixelScore, dropped, hash,
    pixelReason: reasons.join(', '),
    features: {
      lapVar: Math.round(lapVar),
      brightness: Math.round(mean),
      warmth: Math.round(sumWarm / n),
      borderEdges: borderN ? +(borderEdge / borderN).toFixed(4) : 0,
      centerDetail: +((centerN ? centerEdge / centerN : 0) / ((borderN ? borderEdge / borderN : 0) + 0.01)).toFixed(3),
      highlights: +(blown / n).toFixed(4),
      dominantColor: cn ? colorName(cr / cn, cg / cn, cb / cn) : null,
      histogram: hist.map((v) => +(v / n).toFixed(3)),
    },
  };
}

// Group near-duplicates; keep the best of each group.
export function markDuplicates(results) {
  const live = results.filter((r) => !r.dropped);
  for (const r of results) r.duplicateOf = null;
  const sorted = [...live].sort((a, b) => b.pixelScore - a.pixelScore);
  const keepers = [];
  for (const r of sorted) {
    const k = keepers.find((x) => hamming(x.hash, r.hash) <= LIMITS.dupDistance);
    if (k) r.duplicateOf = k.id;
    else keepers.push(r);
  }
  return results;
}
