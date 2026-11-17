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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PHOTOS = path.join(DATA, 'photos');
const DB_FILE = path.join(DATA, 'db.json');
const PORT = Number(process.env.PORT || 3000);
const brand = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib/brand.json'), 'utf8'));

fs.mkdirSync(PHOTOS, { recursive: true });

// ---------- tiny JSON "database" ----------
let db = { posts: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const findPost = (id) => db.posts.find((p) => p.id === id);
const serviceById = (id) => brand.services.find((s) => s.id === id) || null;

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

async function buildPost({ tech, serviceId, photos }) {
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(PHOTOS, id);
  fs.mkdirSync(dir, { recursive: true });
  const service = serviceById(serviceId);

  const stored = photos.slice(0, 30).map((p, i) => {
    const pid = `p${i + 1}`;
    const b64 = String(p.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(path.join(dir, `${pid}.jpg`), Buffer.from(b64, 'base64'));
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

  const candidates = stored.filter((s) => !s.dropped && !s.duplicateOf);
  const vision = candidates.length
    ? await scoreWithFallback({ photos: candidates.map((s) => ({ id: s.id, jpegBase64: s._b64, features: s.features })), service, brand })
    : { photos: {}, attributes: {}, provider: 'none' };

  for (const s of stored) {
    delete s._b64; delete s.duplicateOfClient;
    const v = vision.photos[s.id];
    if (v) {
      s.checks.framing = v.framing; s.checks.background = v.background; s.checks.houseStyle = v.houseStyle;
      s.detailCloseup = v.detailCloseup;
      s.score = Math.round(Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + w * (s.checks[k] ?? 0), 0));
      const words = [s.pixelReason, v.reason].filter(Boolean).join(', ').split(/\s+/);
      s.reason = words.slice(0, 12).join(' ').replace(/,$/, '');
    } else {
      s.score = s.dropped ? Math.round((s.checks.sharpness + s.checks.glare + s.checks.exposure) / 6) : null;
      s.reason = s.dropped ? s.dropped : s.duplicateOf ? `Near-copy of ${s.duplicateOf}, kept the better one` : '';
    }
  }

  // Hero + carousel (up to 4 more), detail close-up second.
  const ranked = stored.filter((s) => s.score != null && !s.dropped && !s.duplicateOf).sort((a, b) => b.score - a.score);
  const hero = ranked[0] || null;
  let rest = ranked.slice(1);
  const detail = rest.find((s) => s.detailCloseup);
  if (detail) rest = [detail, ...rest.filter((s) => s !== detail)];
  const carouselIds = rest.slice(0, 4).map((s) => s.id);

  const captions = await draftCaptions({ brand, service, attributes: vision.attributes });

  const post = {
    id,
    createdAt: new Date().toISOString(),
    tech: tech || 'Nail tech',
    serviceId,
    status: 'needs_approval',
    photos: stored,
    heroId: hero?.id || null,
    carouselIds,
    attributes: vision.attributes,
    visionProvider: vision.provider,
    retakeTip: hero && hero.score < 60 ? retakeTip(hero) : null,
    captions: { ...captions, seed: 0 },
    chosen: 'A',
    edits: {},
    scheduledFor: null,
    approvedAt: null,
    postedAt: null,
    metrics: { taps: 0 },
  };
  db.posts.unshift(post);
  save();
  return post;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
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
      if (req.method === 'GET' && url.pathname === '/api/config') {
        const vp = await pickVisionProvider();
        return send(res, 200, { brand, visionProvider: vp.label, live: vp.name === 'claude' });
      }
      if (req.method === 'GET' && url.pathname === '/api/posts') return send(res, 200, { posts: db.posts });
      if (req.method === 'POST' && url.pathname === '/api/sets') {
        const body = await readBody(req);
        if (!Array.isArray(body.photos) || !body.photos.length) return send(res, 400, { error: 'Add at least one photo.' });
        return send(res, 200, { post: await buildPost(body) });
      }
      if (req.method === 'POST' && url.pathname === '/api/posts/approve-all') {
        const now = new Date().toISOString();
        for (const p of db.posts.filter((p) => p.status === 'needs_approval' && p.heroId)) {
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
          const out = await draftCaptions({ brand, service: serviceById(post.serviceId), attributes: post.attributes, tweak: body.tweak, current: post.captions.options, seed });
          post.captions = { ...out, seed };
          post.edits = {};
          save();
          return send(res, 200, { post });
        }
        if (req.method === 'POST' && action === 'approve') {
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
    if (parts[0] === 'photos') return serveFile(res, PHOTOS, parts.slice(1).join('/'));
    return serveFile(res, PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  const vp = await pickVisionProvider();
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`\n  Set → Post for ${brand.name}`);
  console.log(`  Open on this computer:  http://localhost:${PORT}`);
  if (lan) console.log(`  Open on a phone (same Wi-Fi): http://${lan}:${PORT}  (share sheet + clipboard need HTTPS, see README)`);
  console.log(`  Photo picker: ${vp.label}\n`);
});
