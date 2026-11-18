// On-demand requests ("Uber-style"): a client asks for a service now or at a set
// time, at one of the studios or as a house call. Every artist who is on call,
// does that service, works at that studio (or will travel that far) and is free
// at that time sees the job and can accept or decline. Depending on the owner's
// setting, the first artist to accept gets it, or Tina picks one.
//
// No money is handled here: the menu price is shown for reference only.
import crypto from 'node:crypto';
import { resolveBooking } from './menu.js';

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// Straight-line miles between two points.
export function miles(a, b) {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return null;
  const R = 3958.8, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

export const DEFAULT_ONCALL = { on: false, until: null, hours: [], houseCalls: false, radiusMi: 10, takes: 'both' };

// ----- availability in studio time (Los Angeles) -----
// An artist is available at a moment if their On call switch covers it (until a set
// time, or until they turn it off), or if it falls in their regular weekly hours,
// e.g. Fri and Sat 20:00 to 02:00 (a window past midnight ends the next morning).
const TZ = 'America/Los_Angeles';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtParts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
function laClock(ts) {
  const parts = fmtParts.formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: DAYS.indexOf(get('weekday')), min: Number(get('hour')) * 60 + Number(get('minute')) };
}
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
// The weekly window that covers a moment, if any.
export function windowAt(hours, ts) {
  if (!hours?.length) return null;
  const { day, min } = laClock(ts);
  return hours.find((w) => {
    const a = toMin(w.start), b = toMin(w.end);
    return w.days.some((d) => (a < b ? day === d && min >= a && min < b : (day === d && min >= a) || (day === (d + 1) % 7 && min < b)));
  }) || null;
}
const switchCovers = (oc, ts) => !!oc.on && (!oc.until || ts < Date.parse(oc.until));
export const availableAt = (oc, ts) => switchCovers(oc, ts) || !!windowAt(oc.hours, ts);

export function createDispatch(brand, db, save) {
  db.requests ||= [];
  db.oncall ||= {};
  // On-call history for the owner's activity view: one entry per stretch of the switch
  // being on ({ techId, from, to }); to is null while it's on until turned off.
  db.oncallLog ||= [];
  const openLog = (techId) => db.oncallLog.find((e) => e.techId === techId && (!e.to || Date.parse(e.to) > Date.now()));
  function logOncall(techId, wasOn, isOn, until) {
    const now = new Date().toISOString(), cur = wasOn ? openLog(techId) : null;
    if (isOn && cur) cur.to = until || null;
    else if (isOn) db.oncallLog.push({ techId, from: now, to: until || null });
    else if (cur) cur.to = now;
    if (db.oncallLog.length > 2000) db.oncallLog.splice(0, db.oncallLog.length - 2000);
  }
  db.settings ||= {};
  const settings = () => ({ assign: brand.onDemand?.assign || 'first', ...db.settings });
  const expireMs = (brand.onDemand?.expireMinutes || 20) * 60_000;
  const openStudios = () => brand.locations.filter((l) => l.status === 'open');
  const locById = (id) => brand.locations.find((l) => l.id === id) || null;
  const techById = (id) => brand.techs.find((t) => t.id === id && t.active !== false) || null;
  const techName = (id) => brand.techs.find((t) => t.id === id)?.name || null;
  const techLocs = (t) => (t.locationIds?.length ? t.locationIds : openStudios().map((l) => l.id)).map(locById).filter((l) => l && l.status === 'open');
  // What an artist's on-call state is right now, for screens and dispatch.
  const oncallOf = (techId) => {
    const { travelFee, minimum, ...oc } = { ...DEFAULT_ONCALL, ...db.oncall[techId] };
    const now = Date.now();
    if (oc.on && oc.until && now >= Date.parse(oc.until)) { oc.on = false; oc.until = null; } // ran out
    const win = oc.on ? null : windowAt(oc.hours, now);
    return { ...oc, activeNow: oc.on || !!win, by: oc.on ? 'switch' : win ? 'hours' : null, windowEnd: win?.end || null };
  };

  // When a booking starts and ends. A right-now job starts when it's confirmed.
  const startOf = (r) => Date.parse(r.when === 'now' ? r.confirmedAt || r.createdAt : r.when);
  const endOf = (r) => startOf(r) + r.minutes * 60_000;

  function sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, oc] of Object.entries(db.oncall)) {
      if (oc.on && oc.until && now >= Date.parse(oc.until)) { oc.on = false; oc.until = null; changed = true; }
    }
    for (const r of db.requests) {
      if (r.status !== 'searching') continue;
      const deadline = r.when === 'now' ? Date.parse(r.createdAt) + expireMs : Date.parse(r.when);
      if (now > deadline) { r.status = 'expired'; r.closedAt = new Date().toISOString(); changed = true; }
    }
    if (changed) save();
  }

  // The booking an artist already has at that time, if any.
  function clash(r, techId) {
    const s = r.when === 'now' ? Date.now() : Date.parse(r.when);
    const e = s + r.minutes * 60_000;
    return db.requests.find((x) => x !== r && x.status === 'confirmed' && x.techId === techId && startOf(x) < e && endOf(x) > s) || null;
  }

  // Why an artist can't take a request (null = they can).
  function blocker(r, techId) {
    const tech = techById(techId);
    if (!tech) return 'not on the team';
    if (r.preferTechId && r.preferTechId !== techId) return 'asked for someone else';
    const oc = oncallOf(techId);
    const at = r.when === 'now' ? Date.now() : Date.parse(r.when);
    if (!availableAt(oc, at)) return r.when === 'now' ? 'off call' : 'not available then';
    if (tech.serviceIds && !tech.serviceIds.includes(r.serviceId)) return 'doesn’t do this service';
    if (r.when === 'now' ? oc.takes === 'later' : oc.takes === 'now') return r.when === 'now' ? 'only takes booked-ahead jobs' : 'only takes right-now jobs';
    if (r.where.type === 'studio') {
      if (!techLocs(tech).some((l) => l.id === r.where.locationId)) return 'works at another location';
    } else {
      if (!oc.houseCalls) return 'no house calls';
      const d = distanceFor(r, tech);
      if (d != null && d > oc.radiusMi) return 'too far';
    }
    if (r.declined.includes(techId)) return 'declined';
    if (clash(r, techId)) return 'booked at that time';
    return null;
  }
  // House calls are measured from the artist's nearest studio.
  function distanceFor(r, tech) {
    if (r.where.lat == null) return null;
    const ds = techLocs(tech).map((l) => miles(l, r.where)).filter((d) => d != null);
    return ds.length ? Math.min(...ds) : null;
  }
  const eligible = (r) => brand.techs.filter((t) => t.active !== false).map((t) => t.id).filter((id) => !blocker(r, id));

  function create(body) {
    const b = resolveBooking(brand, { serviceId: body.serviceId, option: body.option });
    if (!b) throw Object.assign(new Error('Pick a service'), { status: 400 });
    const service = brand.services.find((s) => s.id === b.serviceId);
    if (service.options && !service.options.some((o) => o.id === body.option)) throw Object.assign(new Error(`Pick ${service.options.map((o) => o.label.toLowerCase()).join(' or ')}`), { status: 400 });
    const option = service.options?.find((o) => o.id === body.option);

    let when = 'now';
    if (body.when && body.when !== 'now') {
      const t = Date.parse(body.when);
      if (!Number.isFinite(t) || t < Date.now() - 60_000 || t > Date.now() + 60 * 864e5) throw Object.assign(new Error('Pick a time in the next 60 days'), { status: 400 });
      when = new Date(t).toISOString();
    }

    let where;
    if (body.where?.type === 'house') {
      const address = clean(body.where.address, 200);
      const num = (v) => (v == null || v === '' ? NaN : Number(v)); // Number(null) would be 0, a point off Africa
      const lat = num(body.where.lat), lng = num(body.where.lng);
      const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      if (!address && !hasPoint) throw Object.assign(new Error('Add the address for the house call'), { status: 400 });
      where = { type: 'house', address: address || 'Shared location', lat: hasPoint ? lat : null, lng: hasPoint ? lng : null };
      const ds = openStudios().map((l) => miles(l, where)).filter((d) => d != null);
      where.distanceMi = ds.length ? Math.min(...ds) : null;
    } else {
      const loc = openStudios().find((l) => l.id === body.where?.locationId);
      if (!loc) throw Object.assign(new Error('Pick a studio'), { status: 400 });
      where = { type: 'studio', locationId: loc.id };
    }

    const name = clean(body.client?.name, 40);
    const phone = clean(body.client?.phone, 20).replace(/[^0-9+()\- ]/g, '');
    if (!name) throw Object.assign(new Error('Add your first name'), { status: 400 });
    if (phone.replace(/\D/g, '').length < 10) throw Object.assign(new Error('Add a phone number so your artist can reach you'), { status: 400 });
    const preferTechId = techById(body.preferTechId) ? body.preferTechId : null;

    const r = {
      id: crypto.randomUUID().slice(0, 8),
      token: crypto.randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
      serviceId: b.serviceId, serviceName: b.name, priceLabel: b.price,
      minutes: option?.minutes || service.minutes || 60,
      when, where, preferTechId,
      notes: clean(body.notes, 300),
      client: { name, phone },
      status: 'searching',
      declined: [], accepted: [], techId: null,
    };
    r.notified = eligible(r);
    db.requests.unshift(r);
    save();
    return r;
  }

  const placeOf = (r) => (r.where.type === 'studio' ? locById(r.where.locationId) : null);
  const times = (r) => (r.status === 'confirmed' || r.status === 'done' || r.when !== 'now'
    ? { start: new Date(startOf(r)).toISOString(), end: new Date(endOf(r)).toISOString() } : { start: null, end: null });

  // ----- what each side may see -----
  function clientView(r) {
    const loc = placeOf(r);
    return {
      id: r.id, status: r.status, createdAt: r.createdAt, closedAt: r.closedAt || null,
      serviceName: r.serviceName, priceLabel: r.priceLabel, minutes: r.minutes, when: r.when, ...times(r),
      where: r.where.type === 'house' ? { type: 'house', address: r.where.address, distanceMi: r.where.distanceMi } : { type: 'studio', locationId: loc?.id, name: loc?.name, address: loc?.address },
      notes: r.notes, preferTechId: r.preferTechId,
      notifiedCount: r.status === 'searching' ? eligible(r).length : r.notified.length,
      waitingOnStudio: r.status === 'searching' && settings().assign === 'owner' && r.accepted.length > 0,
      pro: r.techId ? { id: r.techId, name: techName(r.techId) } : null,
      studioPhone: (loc || openStudios().find((l) => l.phone))?.phone || null,
      expiresAt: r.when === 'now' ? new Date(Date.parse(r.createdAt) + expireMs).toISOString() : r.when,
    };
  }

  // An artist sees the full address and the client's phone only once the job is theirs.
  function jobView(r, techId) {
    const mine = r.techId === techId;
    const loc = placeOf(r);
    const tech = techById(techId);
    return {
      id: r.id, status: r.status, createdAt: r.createdAt, mine,
      accepted: r.accepted.some((a) => a.techId === techId),
      serviceName: r.serviceName, priceLabel: r.priceLabel, minutes: r.minutes, when: r.when, ...times(r),
      where: r.where.type === 'house'
        ? { type: 'house', distanceMi: tech ? distanceFor(r, tech) : r.where.distanceMi, address: mine ? r.where.address : null, lat: mine ? r.where.lat : null, lng: mine ? r.where.lng : null }
        : { type: 'studio', locationId: loc?.id, name: loc?.name, address: loc?.address },
      notes: r.notes,
      client: mine ? r.client : { name: r.client.name },
      forYou: r.preferTechId === techId,
    };
  }

  function ownerView(r) {
    const loc = placeOf(r);
    return {
      ...jobView(r, r.techId || ''), mine: false,
      where: r.where.type === 'house' ? r.where : { type: 'studio', locationId: loc?.id, name: loc?.name, address: loc?.address },
      client: r.client,
      techId: r.techId, techName: techName(r.techId),
      accepted: r.accepted.map((a) => ({ ...a, name: techName(a.techId) })),
      declined: r.declined.map(techName),
      waiting: r.status === 'searching' ? eligible(r).map(techName) : [],
      preferTechName: techName(r.preferTechId),
      closedAt: r.closedAt || null, cancelledBy: r.cancelledBy || null,
    };
  }

  // ----- actions -----
  const find = (id) => db.requests.find((r) => r.id === id);
  const err = (status, message) => Object.assign(new Error(message), { status });
  function confirm(r, techId) {
    const busy = clash(r, techId);
    if (busy) throw err(409, `${techName(techId)} already has a booking then`);
    r.techId = techId; r.status = 'confirmed'; r.confirmedAt = new Date().toISOString();
  }

  return {
    settings, oncallOf, sweep, create, find, eligible, blocker,
    clientView, jobView, ownerView,
    jobsFor(techId) {
      sweep();
      const open = db.requests.filter((r) => r.status === 'searching' && (!blocker(r, techId) || r.accepted.some((a) => a.techId === techId)));
      const mine = db.requests.filter((r) => r.techId === techId && ['confirmed', 'done'].includes(r.status)).slice(0, 30);
      return { oncall: oncallOf(techId), open: open.map((r) => jobView(r, techId)), mine: mine.map((r) => jobView(r, techId)) };
    },
    ownerJobs() {
      sweep();
      return {
        settings: settings(),
        team: brand.techs.filter((t) => t.active !== false).map((t) => ({ id: t.id, name: t.name, locationIds: t.locationIds || [], ...oncallOf(t.id) })),
        requests: db.requests.slice(0, 80).map(ownerView),
      };
    },
    setOncall(techId, body) {
      const cur = { ...DEFAULT_ONCALL, ...db.oncall[techId] };
      const radius = Number(body.radiusMi);
      const next = {
        on: body.on != null ? !!body.on : cur.on,
        until: cur.until,
        hours: cur.hours || [],
        houseCalls: body.houseCalls != null ? !!body.houseCalls : cur.houseCalls,
        radiusMi: Number.isFinite(radius) && body.radiusMi != null ? Math.min(50, Math.max(1, Math.round(radius))) : cur.radiusMi,
        takes: ['now', 'later', 'both'].includes(body.takes) ? body.takes : cur.takes,
      };
      // How long: forMinutes (1, 2 or 4 hours), until (a time), or neither = until turned off.
      if (body.on === true) {
        if (Number(body.forMinutes) > 0) next.until = new Date(Date.now() + Math.min(24 * 60, Number(body.forMinutes)) * 60_000).toISOString();
        else if (body.until) {
          const t = Date.parse(body.until);
          if (!Number.isFinite(t) || t <= Date.now()) throw Object.assign(new Error('Pick a time later than now'), { status: 400 });
          if (t > Date.now() + 24 * 3600_000) throw Object.assign(new Error('Pick a time in the next 24 hours'), { status: 400 });
          next.until = new Date(t).toISOString();
        } else next.until = null;
      }
      if (body.on === false) next.until = null;
      if (body.hours !== undefined) {
        if (!Array.isArray(body.hours) || body.hours.length > 14) throw Object.assign(new Error('Too many time slots'), { status: 400 });
        next.hours = body.hours.map((w) => {
          const days = [...new Set((w.days || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
          const ok = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t));
          if (!days.length) throw Object.assign(new Error('Pick at least one day'), { status: 400 });
          if (!ok(w.start) || !ok(w.end) || w.start === w.end) throw Object.assign(new Error('Pick a start and an end time'), { status: 400 });
          return { days, start: w.start, end: w.end };
        });
      }
      logOncall(techId, oncallOf(techId).on, next.on, next.until);
      db.oncall[techId] = next;
      save();
      return oncallOf(techId);
    },
    setSettings(body) {
      if (['first', 'owner'].includes(body.assign)) db.settings.assign = body.assign;
      // Switching to "first to accept" books waiting jobs with whoever accepted first and is still free.
      if (settings().assign === 'first') {
        for (const r of db.requests) {
          if (r.status !== 'searching') continue;
          const a = r.accepted.find((x) => !clash(r, x.techId));
          if (a) confirm(r, a.techId);
        }
      }
      save();
      return settings();
    },
    accept(r, techId) {
      if (r.status !== 'searching') throw err(409, r.techId === techId ? 'This job is already yours' : 'Someone else took this one');
      const why = blocker(r, techId);
      if (why && why !== 'declined') throw err(409, `You can’t take this one: ${why}`);
      r.declined = r.declined.filter((id) => id !== techId);
      if (!r.accepted.some((a) => a.techId === techId)) r.accepted.push({ techId, at: new Date().toISOString() });
      if (settings().assign === 'first') confirm(r, techId);
      save();
    },
    decline(r, techId) {
      if (r.status !== 'searching') return;
      r.accepted = r.accepted.filter((a) => a.techId !== techId);
      if (!r.declined.includes(techId)) r.declined.push(techId);
      save();
    },
    assign(r, techId) {
      if (r.status !== 'searching') throw err(409, 'This request is no longer open');
      if (!r.accepted.some((a) => a.techId === techId)) throw err(409, 'Only an artist who accepted can be given the job');
      confirm(r, techId); save();
    },
    done(r, techId) {
      if (r.status !== 'confirmed' || (techId && r.techId !== techId)) throw err(409, 'Only the booked artist can finish this job');
      r.status = 'done'; r.closedAt = new Date().toISOString(); save();
    },
    cancel(r, by) {
      if (!['searching', 'confirmed'].includes(r.status)) throw err(409, 'This request is already closed');
      r.status = 'cancelled'; r.cancelledBy = by; r.closedAt = new Date().toISOString(); save();
    },
    // When a tech leaves the team, their open bookings go back to the studio to sort out.
    releaseTech(techId) {
      logOncall(techId, oncallOf(techId).on, false, null);
      db.oncall[techId] = { ...DEFAULT_ONCALL, ...db.oncall[techId], on: false, until: null };
      for (const r of db.requests) {
        if (r.status === 'confirmed' && r.techId === techId && endOf(r) > Date.now()) { r.status = 'searching'; r.techId = null; r.accepted = []; r.reopened = true; }
        r.accepted = r.accepted.filter((a) => a.techId !== techId);
      }
      save();
    },
    // Public pages show who is on call and free right now, nothing else.
    onCallNow: () => brand.techs.filter((t) => {
      if (t.active === false) return false;
      const oc = oncallOf(t.id);
      const now = Date.now();
      const busy = db.requests.some((r) => r.status === 'confirmed' && r.techId === t.id && startOf(r) <= now && endOf(r) > now);
      return oc.activeNow && oc.takes !== 'later' && !busy;
    }).map((t) => t.id),
  };
}
