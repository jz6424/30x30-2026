// Agent API: lets an outside AI agent (a Converge Covey agent, for example) work on
// the same data as the app, with a secret token instead of a staff PIN.
//
// The agent can read the brand profile, read sets and their photos, write better
// captions, change the photo pick, move a post's date, and read team activity.
// It can't approve, post, delete, see clients' names or phone numbers, or touch
// money (there is none). Tina still approves every post in /studio.
//
// Turn it on by setting AGENT_TOKEN (a long random string) on the server. Calls send
//   Authorization: Bearer <AGENT_TOKEN>
import crypto from 'node:crypto';

export function agentAuthorized(req) {
  const token = process.env.AGENT_TOKEN || '';
  if (token.length < 24) return false; // off unless a real token is set
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const err = (status, message) => Object.assign(new Error(message), { status });
const clean = (s, max) => String(s ?? '').replace(/\u0000/g, '').trim().slice(0, max);

export function createAgentApi({ brand, db, save, findPost, nextFreeSlot, activity, dispatch }) {
  const base = (req) => `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const locName = (id) => brand.locations.find((l) => l.id === id)?.name || null;

  function postView(p, req) {
    const abs = (u) => base(req) + u;
    return {
      id: p.id, createdAt: p.createdAt, status: p.status, stage: p.stage,
      tech: p.tech, techId: p.techId, locationId: p.locationId, location: locName(p.locationId),
      service: p.booking ? { id: p.booking.serviceId, name: p.booking.name, price: p.booking.price, addons: (p.booking.addons || []).map((a) => a.name) } : null,
      attributes: p.attributes,
      photos: p.photos.map((x) => ({ id: x.id, url: abs(x.url), width: x.width, height: x.height, score: x.score ?? null, reason: x.reason || '', checks: x.checks || {}, dropped: x.dropped || null, duplicateOf: x.duplicateOf || null })),
      heroId: p.heroId, carouselIds: p.carouselIds,
      captions: { source: p.captions?.source || null, chosen: p.chosen, options: (p.captions?.options || []).map((o) => ({ key: o.key, label: o.label, ig: p.edits?.[`${o.key}.ig`] ?? o.ig, fb: p.edits?.[`${o.key}.fb`] ?? o.fb })) },
      scheduledFor: p.scheduledFor, approvedAt: p.approvedAt, postedAt: p.postedAt,
    };
  }

  function brandProfile() {
    const { name, handle, address, hours, taglines, igVoice, fbVoice, hashtags, provenHook, bookingUrl, instagramUrl, services, addons } = brand;
    return {
      name, handle, address, hours, taglines, igVoice, fbVoice, hashtags, provenHook,
      bookingUrl: bookingUrl && !bookingUrl.includes('{{') ? bookingUrl : null, instagramUrl,
      services: services.map(({ id, name, price, group, options, minutes }) => ({ id, name, price, group, options: options?.map((o) => ({ id: o.id, label: o.label, price: o.price })), minutes })),
      addons: (addons || []).map(({ id, name, price }) => ({ id, name, price })),
      locations: brand.locations.filter((l) => l.status !== 'hidden').map(({ id, name, address, status, hours }) => ({ id, name, address, status, hours })),
      techs: brand.techs.filter((t) => t.active !== false).map(({ id, name, specialties, locationIds, instagram }) => ({ id, name, specialties, locationIds, instagram })),
      rules: [
        'Use only services and prices listed here. Never invent offers, discounts or prices.',
        'Always mention DTLA (Downtown LA on Facebook) and a booking call to action: "Link in bio to book" on Instagram, the booking link on Facebook.',
        'Instagram: about 60 words or fewer plus 6 to 10 hashtags. Facebook: about 80 words or fewer, at most 3 hashtags.',
        'Never change the nail art, hands or colors in photos.',
        'Tina approves every post. Agents draft and suggest; they never publish.',
      ],
    };
  }

  async function handle(req, res, { parts, url, readBody, send }) {
    const [, , kind, id, action] = parts; // /api/agent/<kind>/<id>/<action>
    const method = req.method;
    if (!kind && method === 'GET') {
      return send(res, 200, {
        ok: true, app: 'Confessionail Set → Post', endpoints: [
          'GET  /api/agent/brand', 'GET  /api/agent/posts?status=needs_approval|ready|posted|all', 'GET  /api/agent/posts/:id',
          'POST /api/agent/posts/:id/captions  {options:[{key:"A",ig,fb},{key:"B",...},{key:"C",...}], note?}',
          'POST /api/agent/posts/:id/pick      {heroId, carouselIds:[...], scores?:[{id,score,reason}]}',
          'POST /api/agent/posts/:id/schedule  {scheduledFor: ISO time}', 'GET  /api/agent/schedule', 'GET  /api/agent/activity?days=7|30|0',
        ],
      });
    }
    if (kind === 'brand' && method === 'GET') return send(res, 200, brandProfile());
    if (kind === 'activity' && method === 'GET') {
      const days = [7, 30, 0].includes(Number(url.searchParams.get('days'))) ? Number(url.searchParams.get('days')) : 7;
      const a = activity(brand, db, dispatch, days);
      a.techs = a.techs.map(({ oncall, ...t }) => t);
      return send(res, 200, a);
    }
    if (kind === 'schedule' && method === 'GET') {
      const list = db.posts.filter((p) => p.status === 'ready').sort((a, b) => Date.parse(a.scheduledFor || 0) - Date.parse(b.scheduledFor || 0));
      return send(res, 200, { posts: list.map((p) => ({ id: p.id, service: p.booking?.name || null, tech: p.tech, scheduledFor: p.scheduledFor, overdue: !!p.scheduledFor && Date.parse(p.scheduledFor) < Date.now() })), nextFreeSlot: nextFreeSlot() });
    }
    if (kind !== 'posts') throw err(404, 'Unknown agent route');

    if (!id && method === 'GET') {
      const status = url.searchParams.get('status') || 'needs_approval';
      const list = db.posts.filter((p) => status === 'all' || p.status === status).slice(0, 50);
      return send(res, 200, { posts: list.map((p) => postView(p, req)) });
    }
    const post = findPost(id);
    if (!post) throw err(404, 'No set with that id');
    if (!action && method === 'GET') return send(res, 200, { post: postView(post, req) });
    if (method !== 'POST') throw err(405, 'Use POST');
    const body = await readBody(req, 40_000);
    if (post.status === 'posted') throw err(409, 'This set is already posted');

    if (action === 'captions') {
      if (post.stage) throw err(409, 'This set is still getting ready. Try again in a minute');
      const opts = Array.isArray(body.options) ? body.options : [];
      if (opts.length !== 3) throw err(400, 'Send exactly 3 options: A, B and C, each with ig and fb');
      const labels = { A: 'Short & playful', B: 'Detail', C: '24-hour hook' };
      post.captions = {
        source: clean(body.source || 'Covey', 30), seed: post.captions?.seed || 0,
        options: opts.map((o, i) => {
          const key = 'ABC'[i], ig = clean(o.ig, 2200), fb = clean(o.fb, 3000);
          if (!ig || !fb) throw err(400, `Option ${key} needs both ig and fb text`);
          return { key, label: clean(o.label, 30) || labels[key], ig, fb };
        }),
        note: clean(body.note, 200) || null,
      };
      post.edits = {};
      save();
      return send(res, 200, { post: postView(post, req) });
    }
    if (action === 'pick') {
      if (post.stage === 'picking') throw err(409, 'Photos are still being checked. Try again in a minute');
      const ids = new Set(post.photos.map((p) => p.id));
      if (!ids.has(body.heroId)) throw err(400, 'heroId must be one of the set’s photo ids');
      for (const s of Array.isArray(body.scores) ? body.scores : []) {
        const ph = post.photos.find((p) => p.id === s.id);
        if (!ph) continue;
        if (Number.isFinite(Number(s.score))) ph.score = Math.max(0, Math.min(100, Math.round(Number(s.score))));
        if (s.reason) ph.reason = clean(s.reason, 90);
      }
      post.heroId = body.heroId;
      post.carouselIds = (Array.isArray(body.carouselIds) ? body.carouselIds : []).filter((i) => ids.has(i) && i !== body.heroId).slice(0, 9);
      save();
      return send(res, 200, { post: postView(post, req) });
    }
    if (action === 'schedule') {
      if (post.status !== 'ready') throw err(409, 'Only approved sets can be scheduled. Tina approves them in the studio app');
      const t = Date.parse(body.scheduledFor);
      if (!Number.isFinite(t) || t < Date.now() || t > Date.now() + 60 * 864e5) throw err(400, 'Pick a time in the next 60 days');
      post.scheduledFor = new Date(t).toISOString();
      save();
      return send(res, 200, { post: postView(post, req) });
    }
    throw err(404, 'Unknown agent route');
  }
  return { handle };
}
