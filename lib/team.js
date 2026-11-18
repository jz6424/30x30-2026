// The team and the locations, managed by Tina in Studio > Admin.
// They start from lib/brand.json, then live in data/db.json so changes stick.
// brand.techs and brand.locations point at the same arrays, so every part of
// the app sees edits right away.

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x';

export function setupTeam(brand, db, save) {
  db.techs ||= structuredClone(brand.techs);
  db.locations ||= structuredClone(brand.locations);
  brand.techs = db.techs;
  brand.locations = db.locations;
  const uniqueId = (base, list) => { let id = slug(base), n = 2; while (list.some((x) => x.id === id) || id === 'tina') id = `${slug(base)}-${n++}`; return id; };

  function techFields(body, cur = {}) {
    const name = clean(body.name ?? cur.name, 30);
    if (!name) throw bad('Add a name');
    const list = (v, n) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => clean(x, n)).filter(Boolean);
    const serviceIds = list(body.serviceIds ?? cur.serviceIds, 40).filter((id) => brand.services.some((s) => s.id === id));
    const locationIds = list(body.locationIds ?? cur.locationIds, 40).filter((id) => db.locations.some((l) => l.id === id));
    if (!serviceIds.length) throw bad('Pick at least one service they do');
    if (!locationIds.length) throw bad('Pick at least one location they work at');
    const ig = clean(body.instagram ?? cur.instagram ?? '', 31).replace(/^@/, '').replace(/[^A-Za-z0-9._]/g, '');
    return {
      name,
      bio: clean(body.bio ?? cur.bio, 280),
      instagram: ig ? '@' + ig : null,
      specialties: list(body.specialties ?? cur.specialties, 30).slice(0, 8),
      serviceIds, locationIds,
    };
  }

  function locationFields(body, cur = {}) {
    const name = clean(body.name ?? cur.name, 40);
    if (!name) throw bad('Add a name for the location');
    const status = ['open', 'coming-soon', 'hidden'].includes(body.status) ? body.status : cur.status || 'open';
    const address = clean(body.address ?? cur.address, 120) || null;
    let lat = cur.lat ?? null, lng = cur.lng ?? null;
    if (body.point !== undefined) {
      // "34.0464, -118.2538", as copied from Google Maps.
      const m = String(body.point || '').match(/(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
      if (String(body.point || '').trim() && !m) throw bad('Map point should look like 34.0464, -118.2538');
      lat = m ? Number(m[1]) : null; lng = m ? Number(m[2]) : null;
      if (m && (Math.abs(lat) > 90 || Math.abs(lng) > 180)) throw bad('That map point is off the map');
    }
    if (status === 'open' && !address) throw bad('An open location needs an address');
    return {
      name, status, address, lat, lng,
      hours: clean(body.hours ?? cur.hours, 40) || (status === 'open' ? 'Open 24 hours' : 'Coming soon'),
      hoursDetail: clean(body.hoursDetail ?? cur.hoursDetail, 120),
      phone: clean(body.phone ?? cur.phone ?? '', 20).replace(/[^0-9+()\- ]/g, '') || null,
    };
  }

  return {
    addTech(body) {
      const t = { id: uniqueId(body.name || 'artist', db.techs), ...techFields(body), active: true, addedAt: new Date().toISOString() };
      db.techs.push(t); save(); return t;
    },
    editTech(id, body) {
      const t = db.techs.find((x) => x.id === id);
      if (!t) throw Object.assign(new Error('Not on the team'), { status: 404 });
      Object.assign(t, techFields(body, t)); delete t.sample; save(); return t;
    },
    setActive(id, active) {
      const t = db.techs.find((x) => x.id === id);
      if (!t) throw Object.assign(new Error('Not on the team'), { status: 404 });
      t.active = !!active; save(); return t;
    },
    addLocation(body) {
      const l = { id: uniqueId(body.name || 'location', db.locations), ...locationFields(body) };
      db.locations.push(l); save(); return l;
    },
    editLocation(id, body) {
      const l = db.locations.find((x) => x.id === id);
      if (!l) throw Object.assign(new Error('Location not found'), { status: 404 });
      const next = locationFields(body, l);
      if (l.status === 'open' && next.status !== 'open' && db.locations.filter((x) => x.status === 'open').length === 1) throw bad('Keep at least one location open');
      Object.assign(l, next); delete l.sample; save(); return l;
    },
  };
}
