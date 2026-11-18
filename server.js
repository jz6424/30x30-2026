// Set → Post: local server for the Confessionail Studio post hub.
// Run: node server.js   (no install needed; add ANTHROPIC_API_KEY + npm install for live Claude)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scoreWithFallback, pickVisionProvider } from './lib/vision.js';
import { draftCaptions } from './lib/captions.js';
import { resolveBooking, addonAttributes } from './lib/menu.js';
import { createAuth } from './lib/auth.js';
import { createDispatch } from './lib/dispatch.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PHOTOS = path.join(DATA, 'photos');
const DB_FILE = path.join(DATA, 'db.json');
const UPLOADS = path.join(DATA, 'uploads');
const PORT = Number(process.env.PORT || 3000);
const brand = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/brand.json'), 'utf8'));
// Set BOOKING_URL (e.g. in Render) to the studio's real booking page.
if (process.env.BOOKING_URL) brand.bookingUrl = process.env.BOOKING_URL;
const techById = (id) => brand.techs.find((t) => t.id === id) || null;
const auth = createAuth(brand);
const isPublic = (post) => (post.status === 'ready' || post.status === 'posted') && !post.stage;

fs.mkdirSync(PHOTOS, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });

// ---------- tiny JSON "database" ----------
let db = { posts: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const findPost = (id) => db.posts.find((p) => p.id === id);
const dispatch = createDispatch(brand, db, save);
setInterval(() => dispatch.sweep(), 30_000).unref();

// New on-demand requests per IP: at most 8 an hour, so the form can't be spammed.
const requestLog = new Map();
function allowRequest(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const recent = (requestLog.get(ip) || []).filter((t) => Date.now() - t < 3600_000);
  if (recent.length >= 8) return false;
  requestLog.set(ip, [...recent, Date.now()]);
  return true;
}
const tokenOk = (r, t) => {
  const a = Buffer.from(String(r.token)), b = Buffer.from(String(t || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ---------- scheduling: batch in, drip out ----------
// Assumption: one post a day, 12pm Mon–Thu, 7pm Fri–Sun (studio's evening crowd).
function slotFor(day) {
  const d = new Date(day);
  const dow = d.getDay();
  d.setHours(dow === 0 || dow >= 5 ? 19 : 12, 0, 0, 0);
  return d;
}
function nextFreeSlot() {
  const taken = new Set(
    db.posts.filter((p) => p.scheduledFor).map((p) => new Date(p.scheduledFor).toDateString()),
  );
  const now = new Date();
  for (let i = 0; i < 365; i++) {
    const day = new Date(now);
    day.setDate(now.getDate() + i);
    const slot = slotFor(day);
    if (slot <= now) continue;
    if (!taken.has(slot.toDateString())) return slot.toISOString();
  }
  return null;
}

// ---------- scoring ----------
const WEIGHTS = { sharpness: 0.2, glare: 0.1, exposure: 0.1, framing: 0.2, background: 0.2, houseStyle: 0.2 };

function retakeTip(photo) {
  const c = photo.checks;
  const worst = Object.entries(c).sort((a, b) => a[1] - b[1])[0]?.[0];
  return {
    sharpness: 'Tap the nails on screen to focus, and hold the phone still.',
    glare: 'Turn the hand slightly away from the lamp to lose the shine spot.',
    exposure: 'Move closer to the window light, or turn on the ring light.',
    framing: 'Fill the frame with all five nails, none cut off at the edges.',
    background: 'Shoot on the marble or white fur, with nothing else in frame.',
    houseStyle: 'Use warm light on marble or white fur for the house look.',
  }[worst] || null;
}

async function buildPost({ techId, tech, locationId, serviceId, option, gel, addons, photos }) {
  const techInfo = techById(techId);
  if (!techInfo && !tech) throw Object.assign(new Error('Pick who did the set'), { status: 400 });
  const location = brand.locations.find((l) => l.id === locationId && l.status === 'open') || brand.locations.find((l) => l.status === 'open');
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(PHOTOS, id);
  fs.mkdirSync(dir, { recursive: true });
  const booking = resolveBooking(brand, { serviceId, option, gel, addons });
  if (!booking) throw Object.assign(new Error('Pick a service from the menu'), { status: 400 });

  const stored = photos.slice(0, 30).map((p, i) => {
    const pid = `p${i + 1}`;
    // Photos arrive one by one through /api/uploads (small requests survive
    // tunnels and slow phone data); dataUrl is still accepted for scripts.
    const dest = path.join(dir, `${pid}.jpg`);
    const up = /^[a-f0-9-]{36}$/.test(p.uploadId || '') ? path.join(UPLOADS, `${p.uploadId}.jpg`) : null;
    if (up && fs.existsSync(up)) fs.renameSync(up, dest);
    else if (p.dataUrl) fs.writeFileSync(dest, Buffer.from(String(p.dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    else throw Object.assign(new Error(`Photo ${i + 1} didn’t arrive. Try again`), { status: 400 });
    const b64 = fs.readFileSync(dest).toString('base64');
    return {
      id: pid,
      clientId: p.id,
      name: p.name || pid,
      url: `/photos/${id}/${pid}.jpg`,
      width: p.width, height: p.height,
      checks: { sharpness: p.checks?.sharpness ?? 0, glare: p.checks?.glare ?? 0, exposure: p.checks?.exposure ?? 0 },
      features: p.features || {},
      pixelReason: p.pixelReason || '',
      dropped: p.dropped || null,
      duplicateOfClient: p.duplicateOf || null,
      _b64: b64,
    };
  });
  // Map client duplicate ids to stored ids.
  const byClient = Object.fromEntries(stored.map((s) => [s.clientId, s.id]));
  for (const s of stored) s.duplicateOf = s.duplicateOfClient ? byClient[s.duplicateOfClient] || null : null;

  for (const s of stored) { delete s._b64; delete s.duplicateOfClient; }

  // Save right away so the tech's upload finishes now. Picking and captions
  // run on the server afterwards; the tech's phone isn't involved.
  const post = {
    id,
    createdAt: new Date().toISOString(),
    techId: techInfo?.id || null,
    tech: techInfo?.name || tech || 'Nail tech',
    locationId: location?.id || null,
    serviceId,
    booking, // service, option, add-ons and price, from lib/brand.json
    status: 'needs_approval',
    stage: 'picking', // picking → captions → null (ready); 'failed' on error
    stageError: null,
    photos: stored,
    heroId: null,
    carouselIds: [],
    attributes: {},
    visionProvider: null,
    retakeTip: null,
    captions: { options: [], source: null, seed: 0 },
    chosen: 'A',
    edits: {},
    scheduledFor: null,
    approvedAt: null,
    postedAt: null,
    metrics: { taps: 0 },
  };
  db.posts.unshift(post);
  save();
  queue(post.id);
  return post;
}

// ---------- background work: pick photos, then write captions ----------
const running = new Set();
function queue(id) {
  if (running.has(id)) return;
  running.add(id);
  processPost(id)
    .catch((err) => {
      console.error(`[post ${id}]`, err.message);
      const p = findPost(id);
      if (p) { p.stage = 'failed'; p.stageError = err.message; save(); }
    })
    .finally(() => running.delete(id));
}

async function processPost(id) {
  let post = findPost(id);
  if (!post) return;
  const service = post.booking || null;
  const stored = post.photos;

  if (post.stage === 'picking' || !post.heroId) {
    post.stage = 'picking'; save();
    const candidates = stored.filter((s) => !s.dropped && !s.duplicateOf);
    const vision = candidates.length
      ? await scoreWithFallback({
          photos: candidates.map((s) => ({ id: s.id, jpegBase64: fs.readFileSync(path.join(PHOTOS, id, `${s.id}.jpg`)).toString('base64'), features: s.features })),
          service, brand,
        })
      : { photos: {}, attributes: {}, provider: 'none' };
    post = findPost(id); if (!post) return; // deleted meanwhile

    for (const s of stored) {
      const v = vision.photos[s.id];
      if (v) {
        s.checks.framing = v.framing; s.checks.background = v.background; s.checks.houseStyle = v.houseStyle;
        s.detailCloseup = v.detailCloseup;
        s.score = Math.round(Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * (s.checks[k] ?? 0), 0));
        const words = [s.pixelReason, v.reason].filter(Boolean).join(', ').split(/\s+/);
        s.reason = words.slice(0, 12).join(' ').replace(/,$/, '');
      } else {
        s.score = s.dropped ? Math.round((s.checks.sharpness + s.checks.glare + s.checks.exposure) / 6) : null;
        s.reason = s.dropped ? s.dropped : s.duplicateOf ? 'Near copy of a better photo, skipped' : '';
      }
    }

    // First photo + carousel (up to 4 more), detail close-up second.
    const ranked = stored.filter((s) => s.score != null && !s.dropped && !s.duplicateOf).sort((a, b) => b.score - a.score);
    const hero = ranked[0] || null;
    let rest = ranked.slice(1);
    const detail = rest.find((s) => s.detailCloseup);
    if (detail) rest = [detail, ...rest.filter((s) => s !== detail)];
    post.heroId = hero?.id || null;
    post.carouselIds = rest.slice(0, 4).map((s) => s.id);
    // The tech's add-ons (chrome, French…) are facts; they win over the model's guess.
    post.attributes = { ...vision.attributes, ...addonAttributes(post.booking) };
    post.visionProvider = vision.provider;
    post.retakeTip = hero && hero.score < 60 ? retakeTip(hero) : null;
    post.stage = 'captions';
    save();
  }

  if (post.stage === 'captions' || !post.captions?.options?.length) {
    const captions = await draftCaptions({ brand, service, attributes: post.attributes });
    post = findPost(id); if (!post) return;
    post.captions = { ...captions, seed: 0 };
    post.edits = {};
  }
  post.stage = null; post.stageError = null;
  save();
}

// ---------- public site data: only approved sets, no captions or drafts ----------
function publicData() {
  const gallery = db.posts
    .filter((p) => isPublic(p) && p.heroId)
    .sort((a, b) => new Date(b.approvedAt || b.createdAt) - new Date(a.approvedAt || a.createdAt))
    .map((p) => ({
      id: p.id,
      techId: p.techId,
      tech: p.tech,
      locationId: p.locationId || 'dtla',
      service: p.booking?.serviceName || null,
      details: p.booking ? [p.booking.name.split(', ').slice(1).join(', '), ...p.booking.addons.filter((a) => !/removal|repair|buff/.test(a.id)).map((a) => a.name)].filter(Boolean) : [],
      photos: [p.heroId, ...p.carouselIds].map((id) => p.photos.find((x) => x.id === id)).filter(Boolean).map((x) => ({ url: x.url, width: x.width, height: x.height })),
      approvedAt: p.approvedAt,
    }));
  const { name, handle, address, hours, taglines, bookingUrl, instagramUrl, techs, locations, services } = brand;
  return {
    brand: { name, handle, address, hours, taglines, bookingUrl, instagramUrl },
    techs, locations,
    services: services.map(({ id, name, price, group, options, minutes, gel }) => ({ id, name, price, group, options, minutes })),
    onCall: dispatch.onCallNow(),
    onDemandNote: brand.onDemand?.note || '',
    gallery,
  };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Photo too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Upload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function serveFile(res, base, rel) {
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'api') {
      // Requests that change things must come from this site.
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        return send(res, 403, { error: 'Cross-site request blocked' });
      }

      // ----- open to everyone -----
      if (req.method === 'GET' && url.pathname === '/api/public') return send(res, 200, publicData());
      if (req.method === 'GET' && url.pathname === '/api/staff') return send(res, 200, { staff: auth.staff });
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const r = auth.login(req, await readBody(req, 10_000));
        if (r.status !== 200) return send(res, r.status, { error: r.error }, r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {});
        return send(res, 200, { user: r.user }, { 'Set-Cookie': r.cookie });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });

      // ----- on-demand requests from clients (no account; a secret link token instead) -----
      if (req.method === 'POST' && url.pathname === '/api/requests') {
        if (!allowRequest(req)) return send(res, 429, { error: 'Too many requests from this device. Call the studio instead' });
        const r = dispatch.create(await readBody(req, 20_000));
        return send(res, 200, { request: dispatch.clientView(r), token: r.token });
      }
      if (parts[1] === 'requests' && parts[2]) {
        dispatch.sweep();
        const r = dispatch.find(parts[2]);
        const t = req.method === 'GET' ? url.searchParams.get('t') : (await readBody(req, 2_000)).t;
        if (!r || !tokenOk(r, t)) return send(res, 404, { error: 'Request not found' });
        if (req.method === 'GET' && !parts[3]) return send(res, 200, { request: dispatch.clientView(r) });
        if (req.method === 'POST' && parts[3] === 'cancel') { dispatch.cancel(r, 'client'); return send(res, 200, { request: dispatch.clientView(r) }); }
      }

      // ----- staff only -----
      const user = auth.userFrom(req);
      if (!user) return send(res, 401, { error: 'Please sign in', signIn: true });
      const owner = user.role === 'owner';
      if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, { user });

      if (req.method === 'GET' && url.pathname === '/api/config') {
        const vp = await pickVisionProvider();
        let phoneUrl = null;
        try { phoneUrl = fs.readFileSync(path.join(DATA, 'phone-url.txt'), 'utf8').trim(); } catch {}
        return send(res, 200, { brand, visionProvider: vp.label, live: vp.name === 'claude', phoneUrl });
      }
      // Techs only see their own sets; the owner sees everything.
      if (req.method === 'GET' && url.pathname === '/api/posts') return send(res, 200, { posts: owner ? db.posts : db.posts.filter((p) => p.techId === user.id) });
      if (req.method === 'POST' && url.pathname === '/api/uploads') {
        const buf = await readRaw(req, 20 * 1024 * 1024);
        if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, { error: 'That file isn’t a JPEG photo' });
        const uploadId = crypto.randomUUID();
        fs.writeFileSync(path.join(UPLOADS, `${uploadId}.jpg`), buf);
        return send(res, 200, { uploadId });
      }
      if (req.method === 'POST' && url.pathname === '/api/sets') {
        const body = await readBody(req);
        if (!Array.isArray(body.photos) || !body.photos.length) return send(res, 400, { error: 'Add at least one photo.' });
        // A tech's upload is always theirs; the owner can upload for any tech.
        if (!owner) { body.techId = user.id; delete body.tech; }
        return send(res, 200, { post: await buildPost(body) });
      }

      // ----- on-demand jobs: techs go on call and take jobs; Tina watches and assigns -----
      if (req.method === 'GET' && url.pathname === '/api/jobs') return send(res, 200, owner ? dispatch.ownerJobs() : dispatch.jobsFor(user.id));
      if (req.method === 'PUT' && url.pathname === '/api/oncall') {
        if (owner) return send(res, 400, { error: 'On call is for nail techs' });
        return send(res, 200, { oncall: dispatch.setOncall(user.id, await readBody(req, 5_000)) });
      }
      if (req.method === 'PUT' && url.pathname === '/api/jobs-settings') {
        if (!owner) return send(res, 403, { error: 'Only the owner can do that' });
        return send(res, 200, { settings: dispatch.setSettings(await readBody(req, 5_000)) });
      }
      if (req.method === 'POST' && parts[1] === 'jobs' && parts[2] && parts[3]) {
        const r = dispatch.find(parts[2]);
        if (!r) return send(res, 404, { error: 'Job not found' });
        const body = await readBody(req, 5_000);
        const act = parts[3];
        if (!owner && act === 'accept') dispatch.accept(r, user.id);
        else if (!owner && act === 'decline') dispatch.decline(r, user.id);
        else if (act === 'done') dispatch.done(r, owner ? null : user.id);
        else if (owner && act === 'assign') dispatch.assign(r, body.techId);
        else if (owner && act === 'cancel') dispatch.cancel(r, 'studio');
        else return send(res, 403, { error: 'You can’t do that' });
        return send(res, 200, owner ? dispatch.ownerJobs() : dispatch.jobsFor(user.id));
      }

      // ----- owner only: review, approve, share, edit, delete -----
      if (!owner) return send(res, 403, { error: 'Only the owner can do that' });
      if (req.method === 'POST' && url.pathname === '/api/posts/approve-all') {
        const now = new Date().toISOString();
        for (const p of db.posts.filter((p) => p.status === 'needs_approval' && p.heroId && !p.stage)) {
          p.status = 'ready'; p.approvedAt = now; p.scheduledFor = nextFreeSlot();
        }
        save();
        return send(res, 200, { posts: db.posts });
      }
      if (parts[1] === 'posts' && parts[2]) {
        const post = findPost(parts[2]);
        if (!post) return send(res, 404, { error: 'Post not found' });
        const action = parts[3];
        const body = req.method === 'GET' ? {} : await readBody(req);
        if (body.taps) post.metrics.taps += Number(body.taps) || 0;

        if (req.method === 'PATCH' && !action) {
          const ids = new Set(post.photos.map((p) => p.id));
          if (body.heroId && ids.has(body.heroId)) post.heroId = body.heroId;
          if (Array.isArray(body.carouselIds)) post.carouselIds = body.carouselIds.filter((i) => ids.has(i) && i !== post.heroId).slice(0, 9);
          if (body.chosen && 'ABC'.includes(body.chosen)) post.chosen = body.chosen;
          if (body.edit && body.edit.key && body.edit.channel) {
            post.edits[`${body.edit.key}.${body.edit.channel}`] = String(body.edit.text || '');
          }
          save();
          return send(res, 200, { post });
        }
        if (req.method === 'POST' && action === 'captions') {
          const seed = (post.captions.seed || 0) + 1;
          const out = await draftCaptions({ brand, service: post.booking || null, attributes: post.attributes, tweak: body.tweak, current: post.captions.options, seed });
          post.captions = { ...out, seed };
          post.edits = {};
          save();
          return send(res, 200, { post });
        }
        if (req.method === 'POST' && action === 'retry') {
          if (post.stage === 'failed') post.stage = post.heroId ? 'captions' : 'picking';
          queue(post.id);
          return send(res, 200, { post });
        }
        if (req.method === 'POST' && action === 'approve') {
          if (post.stage) return send(res, 409, { error: 'This set is still getting ready' });
          post.status = 'ready'; post.approvedAt = new Date().toISOString();
          post.scheduledFor = post.scheduledFor || nextFreeSlot();
          save();
          return send(res, 200, { post });
        }
        if (req.method === 'POST' && action === 'unapprove') {
          post.status = 'needs_approval'; post.scheduledFor = null; post.approvedAt = null;
          save();
          return send(res, 200, { post });
        }
        if (req.method === 'POST' && action === 'posted') {
          post.status = 'posted'; post.postedAt = new Date().toISOString();
          save();
          return send(res, 200, { post });
        }
        if (req.method === 'DELETE' && !action) {
          db.posts = db.posts.filter((p) => p !== post);
          fs.rmSync(path.join(PHOTOS, post.id), { recursive: true, force: true });
          save();
          return send(res, 200, { ok: true });
        }
      }
      return send(res, 404, { error: 'Unknown API route' });
    }
    if (parts[0] === 'photos') {
      // Photos of approved sets are public; others need a staff sign-in.
      const post = findPost(parts[1]);
      if (!post) return send(res, 404, { error: 'Not found' });
      if (!isPublic(post)) {
        const user = auth.userFrom(req);
        if (!user || (user.role !== 'owner' && post.techId !== user.id)) return send(res, 404, { error: 'Not found' });
      }
      return serveFile(res, PHOTOS, parts.slice(1).join('/'));
    }
    // Staff app (techs upload, Tina approves) lives at /studio.
    if (parts[0] === 'studio') return serveFile(res, PUBLIC, 'studio.html');
    // Everything without a file extension is a page of the public site.
    if (!path.extname(url.pathname)) return serveFile(res, PUBLIC, 'site.html');
    return serveFile(res, PUBLIC, url.pathname);
  } catch (err) {
    console.error(`[${req.method} ${url.pathname}]`, err.message);
    return send(res, err.status || 500, { error: err.message });
  }
});

// Finish any sets that were mid-way when the server stopped.
for (const p of db.posts) if (p.stage && p.stage !== 'failed') queue(p.id);

server.listen(PORT, '0.0.0.0', async () => {
  const vp = await pickVisionProvider();
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`\n  Set → Post for ${brand.name}`);
  console.log(`  Open on this computer:  http://localhost:${PORT}`);
  if (lan) console.log(`  Open on a phone (same Wi-Fi): http://${lan}:${PORT}  (no share sheet over plain http: use npm run phone)`);
  console.log(`  Photo picker: ${vp.label}\n`);
});
