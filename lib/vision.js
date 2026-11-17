// Vision scoring behind a pluggable interface.
//
// A provider has: { name, label, scoreSet({ photos, service, brand }) }
// photos: [{ id, jpegBase64, features }] where features come from the
// in-browser pixel checks (public/quality.js).
// It resolves to:
// {
//   photos: { [id]: { framing, background, houseStyle, detailCloseup, reason } },  // scores 0-100
//   attributes: { shape, colors: [], finish, technique },
// }
// Providers only look at photos. They never edit them.
import { getClaude, askForJson } from './claude.js';

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

// Offline estimate from pixel features. Deterministic, free, no network.
export const mockProvider = {
  name: 'offline',
  label: 'Offline estimate (no API key)',
  async scoreSet({ photos }) {
    const out = {};
    let best = null;
    for (const p of photos) {
      const f = p.features || {};
      // Framing: detail concentrated in the middle of the frame.
      const framing = clamp(40 + 60 * Math.tanh((f.centerDetail || 1) - 1));
      // Clean background: few edges around the border.
      const background = clamp(100 - (f.borderEdges || 0) * 900);
      // House style: warm, bright, cream/gold tones.
      const warm = clamp(50 + (f.warmth || 0) * 2.2);
      const bright = clamp(100 - Math.abs((f.brightness || 128) - 165) * 1.1);
      const houseStyle = clamp(warm * 0.6 + bright * 0.4);
      const bits = [];
      if (framing >= 70) bits.push('nails fill the frame');
      else if (framing < 45) bits.push('nails look small in frame');
      if (background >= 70) bits.push('clean background');
      else if (background < 45) bits.push('busy background');
      if (houseStyle >= 70) bits.push('warm house tones');
      else if (houseStyle < 45) bits.push('cool or dim tones');
      out[p.id] = { framing, background, houseStyle, detailCloseup: false, reason: bits.join(', ') };
      if (!best || (f.centerDetail || 0) > best.d) best = { id: p.id, d: f.centerDetail || 0 };
    }
    if (best && photos.length > 1) out[best.id].detailCloseup = true;

    const hue = photos[0]?.features?.dominantColor;
    return {
      photos: out,
      attributes: {
        shape: null,
        colors: hue ? [hue] : [],
        finish: photos.some((p) => (p.features?.highlights || 0) > 0.004) ? 'glossy' : null,
        technique: null,
      },
    };
  },
};

const VISION_SYSTEM = (brand) => `You score photos of finished nail sets for ${brand.name}, a nail salon. You rate photos; you never suggest editing the nail art.
House style: ${brand.houseStyle}
For each photo give 0-100 scores:
- framing: all nails visible, none cut off, nails fill the frame.
- background: clean, uncluttered background (marble or white fur is ideal).
- house_style: how well it matches the house style.
- detail_closeup: true if it is a tight detail shot of the nail art.
- reason: 12 words or fewer, plain words a salon owner would use, e.g. "sharp almond set on marble, nails fill the frame".
Also describe the set as a whole: shape (almond, coffin, square, oval, stiletto or null), colors (plain color words), finish (glossy, matte, chrome, cat eye or null), technique (french, ombre, hand-painted art, 3D charms, gems, solid, or null). Only describe what you can see.
Reply with only JSON:
{"photos":[{"id":"...","framing":0,"background":0,"house_style":0,"detail_closeup":false,"reason":"..."}],"attributes":{"shape":null,"colors":[],"finish":null,"technique":null}}`;

export const claudeProvider = {
  name: 'claude',
  label: 'Claude vision',
  async scoreSet({ photos, service, brand }) {
    const client = await getClaude();
    if (!client) throw new Error('Claude is not configured.');
    const content = [];
    for (const p of photos) {
      content.push({ type: 'text', text: `Photo id: ${p.id}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.jpegBase64 } });
    }
    content.push({ type: 'text', text: `Service booked: ${service?.name || 'not given'}. Score every photo above.` });
    const json = await askForJson(client, { system: VISION_SYSTEM(brand), content });
    const out = {};
    for (const r of json.photos || []) {
      out[r.id] = {
        framing: clamp(r.framing),
        background: clamp(r.background),
        houseStyle: clamp(r.house_style),
        detailCloseup: !!r.detail_closeup,
        reason: String(r.reason || '').split(/\s+/).slice(0, 12).join(' '),
      };
    }
    const a = json.attributes || {};
    return {
      photos: out,
      attributes: {
        shape: a.shape || null,
        colors: Array.isArray(a.colors) ? a.colors.slice(0, 3) : [],
        finish: a.finish || null,
        technique: a.technique || null,
      },
    };
  },
};

const PROVIDERS = { claude: claudeProvider, offline: mockProvider };

export async function pickVisionProvider() {
  const forced = process.env.VISION_PROVIDER;
  if (forced && PROVIDERS[forced]) return PROVIDERS[forced];
  return (await getClaude()) ? claudeProvider : mockProvider;
}

// Score with the chosen provider; fall back to the offline estimate on errors
// so a demo never gets stuck.
export async function scoreWithFallback(args) {
  const provider = await pickVisionProvider();
  try {
    const result = await provider.scoreSet(args);
    // Fill any photo the model skipped.
    const missing = args.photos.filter((p) => !result.photos[p.id]);
    if (missing.length) {
      const extra = await mockProvider.scoreSet({ ...args, photos: missing });
      Object.assign(result.photos, extra.photos);
    }
    return { ...result, provider: provider.label };
  } catch (err) {
    console.warn(`[vision] ${provider.name} failed, using offline estimate:`, err.message);
    const result = await mockProvider.scoreSet(args);
    return { ...result, provider: `${mockProvider.label} (model call failed)` };
  }
}
