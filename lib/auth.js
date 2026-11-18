// PIN sign-in for /studio.
// - Staff: the techs in lib/brand.json (role "tech") plus the owner (role "owner").
// - PINs are scrypt hashes. In order of priority: env var PIN_HASH_<ID> (e.g. PIN_HASH_TINA,
//   make one with: npm run hash-pin -- 482913), then a PIN Tina set in Studio > Admin
//   (saved hashed in data/db.json), then a documented demo PIN (a warning is logged).
// - The team is live: techs Tina adds or removes in Admin can sign in or not right away.
// - Sessions: HTTP-only, SameSite=Lax cookie holding {id, role, exp}, signed with
//   HMAC-SHA256 using SESSION_SECRET.
// - Failed PINs are rate limited per IP and per account.
import crypto from 'node:crypto';

const DEMO_PINS = { tina: '2468', mia: '1111', jasmine: '2222', kim: '3333' };
const COOKIE = 'cs_session';
const SESSION_DAYS = 14;

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkHash(pin, stored) {
  const [kind, saltHex, hashHex] = String(stored).split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export const envPinName = (id) => `PIN_HASH_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

export function createAuth(brand, db, save) {
  db.pins ||= {};
  const owner = { id: 'tina', name: 'Tina', role: 'owner' };
  const staffList = () => [owner, ...brand.techs.filter((t) => t.active !== false).map((t) => ({ id: t.id, name: t.name, role: 'tech' }))];

  const demoHashes = {};
  const usingDemo = [];
  for (const s of staffList()) {
    if (!process.env[envPinName(s.id)] && !db.pins[s.id] && DEMO_PINS[s.id]) { demoHashes[s.id] = hashPin(DEMO_PINS[s.id]); usingDemo.push(s.name); }
  }
  const hashFor = (id) => process.env[envPinName(id)] || db.pins[id] || demoHashes[id] || null;
  if (usingDemo.length) console.warn(`  [auth] Demo PINs in use for: ${usingDemo.join(', ')}. Set PIN_HASH_<ID> env vars before real use (see README).`);

  const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  if (!process.env.SESSION_SECRET) console.warn('  [auth] SESSION_SECRET not set: sign-ins reset when the server restarts.');

  const sign = (data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

  function cookieFor(user, req) {
    const payload = Buffer.from(JSON.stringify({ id: user.id, role: user.role, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
    return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
  }
  const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

  function userFrom(req) {
    const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
    if (!raw) return null;
    const [payload, sig] = raw.slice(COOKIE.length + 1).split('.');
    if (!payload || !sig) return null;
    const good = Buffer.from(sign(payload));
    const given = Buffer.from(sig);
    if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (data.exp < Date.now()) return null;
      const s = staffList().find((x) => x.id === data.id && x.role === data.role);
      return s ? { ...s } : null;
    } catch { return null; }
  }

  // Rate limit: 5 wrong PINs per account per IP in 15 minutes, 20 per IP overall.
  const WINDOW = 15 * 60 * 1000;
  const fails = new Map(); // key -> [timestamps]
  const recent = (key) => (fails.get(key) || []).filter((t) => Date.now() - t < WINDOW);
  function blockedFor(ip, id) {
    const a = recent(`${ip}|${id}`), b = recent(ip);
    if (a.length >= 5) return Math.ceil((a[0] + WINDOW - Date.now()) / 1000);
    if (b.length >= 20) return Math.ceil((b[0] + WINDOW - Date.now()) / 1000);
    return 0;
  }
  function noteFail(ip, id) {
    for (const key of [`${ip}|${id}`, ip]) fails.set(key, [...recent(key), Date.now()]);
  }

  function login(req, { id, pin }) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    const user = staffList().find((s) => s.id === id);
    const wait = blockedFor(ip, String(id));
    if (wait) return { status: 429, error: `Too many wrong PINs. Try again in ${Math.ceil(wait / 60)} min`, retryAfter: wait };
    if (!user || !/^\d{4,6}$/.test(String(pin || '')) || !hashFor(user.id) || !checkHash(pin, hashFor(user.id))) {
      noteFail(ip, String(id));
      const left = 5 - recent(`${ip}|${id}`).length;
      return { status: 401, error: left > 0 ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left` : 'Too many wrong PINs. Try again in 15 min' };
    }
    fails.delete(`${ip}|${id}`);
    return { status: 200, user, cookie: cookieFor(user, req) };
  }

  return {
    get staff() { return staffList(); },
    userFrom, login, clearCookie,
    // Tina sets or resets a PIN in Admin. An env var PIN wins, so say so instead of silently ignoring it.
    setPin(id, pin) {
      if (!/^\d{4,6}$/.test(String(pin || ''))) throw Object.assign(new Error('A PIN is 4 to 6 digits'), { status: 400 });
      if (process.env[envPinName(id)]) throw Object.assign(new Error(`This PIN is set on the server (${envPinName(id)}). Change it there`), { status: 409 });
      db.pins[id] = hashPin(pin); delete demoHashes[id]; save();
    },
    pinSource: (id) => (process.env[envPinName(id)] ? 'server' : db.pins[id] ? 'admin' : demoHashes[id] ? 'demo' : 'none'),
  };
}
