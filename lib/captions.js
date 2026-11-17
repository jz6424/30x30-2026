// Caption drafting: three options (A short & playful, B detail, C 24-hour hook),
// each with an Instagram and a Facebook version.
// Uses Claude when configured, otherwise a template writer in the studio voice.
import { getClaude, askForJson } from './claude.js';

const LABELS = { A: 'Short & playful', B: 'Detail', C: '24-hour hook' };

function fromPrice(service) {
  if (!service) return null;
  const base = service.price.replace('+', '');
  return service.gelPrice ? `from ${base} (${service.gelPrice} with gel)` : `from ${base}`;
}

function describeLook(attrs = {}) {
  const parts = [];
  if (attrs.colors?.length) parts.push(attrs.colors.slice(0, 2).join(' & '));
  if (attrs.finish) parts.push(attrs.finish);
  if (attrs.technique && attrs.technique !== 'solid') parts.push(attrs.technique);
  if (attrs.shape) parts.push(attrs.shape);
  return parts.length ? parts.join(' ') : null;
}

function tagify(s) {
  return '#' + String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hashtags(brand, service, attrs, max = 10) {
  const extra = [];
  if (attrs?.shape) extra.push(tagify(attrs.shape + 'nails'));
  if (attrs?.finish && attrs.finish !== 'glossy') extra.push(tagify(attrs.finish + 'nails'));
  if (attrs?.technique && attrs.technique !== 'solid') extra.push(tagify(attrs.technique.split(' ')[0] + 'nails'));
  if (service) extra.push(tagify(service.name.replace(/^the /i, '')));
  const all = [...brand.hashtags, ...extra];
  return [...new Set(all)].slice(0, max).join(' ');
}

const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

// Template writer. `seed` changes wording for "New options"; `style` is
// 'normal' | 'shorter' | 'playful'.
export function templateCaptions({ brand, service, attributes, seed = 0, style = 'normal' }) {
  const look = describeLook(attributes);
  const lookOr = look ? `this ${look} set` : 'this set';
  const svc = service ? service.name : null;
  const price = fromPrice(service);
  const tags = hashtags(brand, service, attributes, style === 'shorter' ? 7 : 9);
  const fbTags = '#confessionail #dtla #nailart';
  const emo = style === 'playful' ? ' 💅✨😍' : '';

  const openersA = [
    `Confession: we're obsessed with ${lookOr} 🤭💅`,
    `Spill the tea... how good is ${lookOr}? ☕️✨`,
    `Main character nails, no notes 😮‍💨💖`,
    `Okay but ${lookOr} 😍 we can't stop staring`,
  ];
  const openersC = [
    `${brand.provenHook} 🌙💅`,
    `Late-night nails? We got you 🌙✨`,
    `Can't sleep? Get your nails done 🌙💅`,
  ];

  const a = pick(openersA, seed);
  const c = pick(openersC, seed);
  const svcLine = svc ? `${svc} ${price}.` : '';

  const short = style === 'shorter';
  const options = {
    A: {
      ig: short
        ? `${a}${emo} DTLA, open 24 hours. Link in bio to book. ${tags}`
        : `${a}${emo} Come see us in DTLA, open 24 hours! Link in bio to book 📅 ${tags}`,
      fb: short
        ? `We're loving ${lookOr}. Come see us in DTLA, open 24 hours. Book: ${brand.bookingUrl} ${fbTags}`
        : `We're loving ${lookOr} from our studio this week. Come see us in Downtown LA, we're open 24 hours. Book your visit: ${brand.bookingUrl} ${fbTags}`,
    },
    B: {
      ig: short
        ? `${look ? look[0].toUpperCase() + look.slice(1) : 'Fresh set'} 💅 ${svcLine} DTLA, open 24 hours. Link in bio to book. ${tags}`
        : `Confession: ${lookOr} is our new favorite 💅✨${emo} ${svcLine ? 'This is our ' + svcLine : ''} Walk in 9 to 8, or book any hour after. Open 24 hours in DTLA. Link in bio to book. ${tags}`,
      fb: `${look ? 'This ' + look + ' set' : 'This set'} is ${svc ? `our ${svc}, ${price}` : 'fresh from the studio'}. Walk-ins are welcome 9am to 8pm, and you can book any hour after that. We're open 24 hours in Downtown LA. Book here: ${brand.bookingUrl} ${fbTags}`,
    },
    C: {
      ig: short
        ? `${c}${emo} Open 24 hours in DTLA. Link in bio to book. ${tags}`
        : `${c}${emo} ${look ? 'Sets like this ' + look + ' look,' : 'Sets like this,'} any hour you want. Walk in 9 to 8, book any time after. Open 24 hours in DTLA. Link in bio to book. ${tags}`,
      fb: `Yes, you can get your nails done at 2am. We're open 24 hours in Downtown LA: walk in from 9am to 8pm, or book any hour after that. Book here: ${brand.bookingUrl} ${fbTags}`,
    },
  };
  return ['A', 'B', 'C'].map((key) => ({
    key,
    label: LABELS[key],
    ig: options[key].ig.replace(/\s+/g, ' ').trim(),
    fb: options[key].fb.replace(/\s+/g, ' ').trim(),
  }));
}

const CAPTION_SYSTEM = (brand) => `You write Instagram and Facebook captions for ${brand.name}.
Facts (use only these, never invent offers or prices):
${JSON.stringify({ address: brand.address, hours: brand.hours, taglines: brand.taglines, services: brand.services, bookingUrl: brand.bookingUrl, hashtags: brand.hashtags, provenHook: brand.provenHook })}
Instagram voice: ${brand.igVoice}
Facebook voice: ${brand.fbVoice}
Rules:
- Write 3 options: A "Short & playful", B "Detail" (exact service name plus "from $X"), C "24-hour hook".
- Each option has "ig" and "fb".
- Always mention DTLA (or Downtown LA on Facebook) and a booking call to action. Instagram: "Link in bio to book". Facebook: ${brand.bookingUrl} exactly.
- Instagram: about 60 words or fewer, plus 6 to 10 hashtags (start from the hashtag bank, add 1-3 that describe the set).
- Facebook: about 80 words or fewer, at most 3 hashtags.
- Use confession wordplay ("Confession:", "Spill the tea") when it fits.
- Only describe the nails using the attributes given.
Reply with only JSON: {"options":[{"key":"A","ig":"...","fb":"..."},{"key":"B","ig":"...","fb":"..."},{"key":"C","ig":"...","fb":"..."}]}`;

const TWEAKS = {
  shorter: 'Make all three options noticeably shorter. Keep the rules.',
  playful: 'Make all three options more playful, with more emoji. Keep the rules.',
  new: 'Write three fresh options with different openings from the current ones. Keep the rules.',
};

export async function draftCaptions({ brand, service, attributes, tweak, current, seed = 0 }) {
  const client = await getClaude();
  if (client) {
    try {
      let text = `Service: ${service ? `${service.name} (${fromPrice(service)})` : 'not given'}\nSet attributes: ${JSON.stringify(attributes || {})}`;
      if (tweak && current) text += `\nCurrent options: ${JSON.stringify(current.map(({ key, ig, fb }) => ({ key, ig, fb })))}\n${TWEAKS[tweak]}`;
      const json = await askForJson(client, { system: CAPTION_SYSTEM(brand), content: [{ type: 'text', text }], maxTokens: 3000 });
      const opts = (json.options || []).filter((o) => o.ig && o.fb).slice(0, 3);
      if (opts.length === 3) {
        return { source: 'Claude', options: opts.map((o, i) => ({ key: 'ABC'[i], label: LABELS['ABC'[i]], ig: o.ig.trim(), fb: o.fb.trim() })) };
      }
      throw new Error('Model returned fewer than 3 options.');
    } catch (err) {
      console.warn('[captions] Claude failed, using templates:', err.message);
    }
  }
  const style = tweak === 'shorter' ? 'shorter' : tweak === 'playful' ? 'playful' : 'normal';
  return { source: 'Templates', options: templateCaptions({ brand, service, attributes, seed, style }) };
}
