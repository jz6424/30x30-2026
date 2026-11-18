// On-demand requests ("Uber-style"): a client asks for a service now or at a set
// time, at the studio or as a house call. Every pro who is on call and qualified
// sees the job and can accept or decline. Depending on the owner's setting, the
// first pro to accept gets it, or Tina picks from the pros who accepted.
//
// Demo scope: no payments. Price, travel fee and payout are numbers only
// (Stripe Connect would handle real charges and payouts).
import crypto from 'node:crypto';
import { resolveBooking } from './menu.js';

const money = (s) => Number(String(s).replace(/[^0-9.]/g, '')) || 0;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// Straight-line miles between two points.
export function miles(a, b) {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return null;
  const R = 3958.8, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

export const DEFAULT_ONCALL = { on: false, houseCalls: false, radiusMi: 10, travelFee: 25, minimum: 50, takes: 'both' };

export function createDispatch(brand, db, save) {
  db.requests ||= [];
  db.oncall ||= {};
  db.settings ||= {};
  const settings = () => ({ assign: brand.onDemand?.assign || 'first', payoutPct: brand.onDemand?.payoutPct ?? 60, ...db.settings });
  const expireMs = (brand.onDemand?.expireMinutes || 20) * 60_000;
  const studio = (id) => brand.locations.find((l) => l.id === id && l.status === 'open') || brand.locations.find((l) => l.status === 'open');
  const techName = (id) => brand.techs.find((t) => t.id === id)?.name || null;
  const oncallOf = (techId) => ({ ...DEFAULT_ONCALL, ...db.oncall[techId] });

  // Close requests nobody took in time.
  function sweep() {
    const now = Date.now();
    let changed = false;
    for (const r of db.requests) {
      if (r.status !== 'searching') continue;
      const deadline = r.when === 'now' ? Date.parse(r.createdAt) + expireMs : Date.parse(r.when);
      if (now > deadline) { r.status = 'expired'; r.closedAt = new Date().toISOString(); changed = true; }
    }
    if (changed) save();
  }

  // Why a pro can or can't take a request (null = they can).
  function blocker(r, techId) {
    const tech = brand.techs.find((t) => t.id === techId);
    if (!tech) return 'unknown pro';
    if (r.preferTechId && r.preferTechId !== techId) return 'asked for someone else';
    const oc = oncallOf(techId);
    if (!oc.on) return 'off call';
    if (tech.serviceIds && !tech.serviceIds.includes(r.serviceId)) return 'doesn’t do this service';
    if (r.when === 'now' ? oc.takes === 'later' : oc.takes === 'now') return r.when === 'now' ? 'only takes booked-ahead jobs' : 'only takes right-now jobs';
    if (r.where.type === 'house') {
      if (!oc.houseCalls) return 'no house calls';
      if (r.where.distanceMi != null && r.where.distanceMi > oc.radiusMi) return 'too far';
      if (r.price + oc.travelFee < oc.minimum) return 'under their minimum';
    }
    if (r.declined.includes(techId)) return 'declined';
    // One job at a time: a pro with a confirmed right-now job is busy.
    if (r.when === 'now' && db.requests.some((x) => x.status === 'confirmed' && x.techId === techId && x.when === 'now')) return 'busy with a job';
    return null;
  }
  const eligible = (r) => brand.techs.map((t) => t.id).filter((id) => !blocker(r, id));

  function payoutFor(r, techId) {
    const fee = r.where.type === 'house' ? oncallOf(techId).travelFee : 0;
    return { travelFee: fee, payout: Math.round((r.price * settings().payoutPct) / 100) + fee, total: r.price + fee };
  }

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
    const home = studio(body.where?.locationId);
    if (body.where?.type === 'house') {
      const address = clean(body.where.address, 200);
      const num = (v) => (v == null || v === '' ? NaN : Number(v)); // Number(null) would be 0, a point off Africa
      const lat = num(body.where.lat), lng = num(body.where.lng);
      const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
      if (!address && !hasPoint) throw Object.assign(new Error('Add the address for the house call'), { status: 400 });
      where = { type: 'house', address: address || 'Shared location', lat: hasPoint ? lat : null, lng: hasPoint ? lng : null, from: home.id };
      where.distanceMi = hasPoint ? miles(home, where) : null;
    } else {
      where = { type: 'studio', locationId: home.id };
    }

    const name = clean(body.client?.name, 40);
    const phone = clean(body.client?.phone, 20).replace(/[^0-9+()\- ]/g, '');
    if (!name) throw Object.assign(new Error('Add your first name'), { status: 400 });
    if (phone.replace(/\D/g, '').length < 10) throw Object.assign(new Error('Add a phone number so your pro can reach you'), { status: 400 });
    const preferTechId = brand.techs.some((t) => t.id === body.preferTechId) ? body.preferTechId : null;

    const r = {
      id: crypto.randomUUID().slice(0, 8),
      token: crypto.randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
      serviceId: b.serviceId, serviceName: b.name, priceLabel: b.price, price: money(b.price),
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

  // ----- what each side may see -----
  function clientView(r) {
    const s = settings();
    const pro = r.techId ? { id: r.techId, name: techName(r.techId) } : null;
    return {
      id: r.id, status: r.status, createdAt: r.createdAt, closedAt: r.closedAt || null,
      serviceName: r.serviceName, priceLabel: r.priceLabel, minutes: r.minutes,
      when: r.when, where: r.where.type === 'house' ? { type: 'house', address: r.where.address, distanceMi: r.where.distanceMi } : r.where,
      travelFee: r.techId ? payoutFor(r, r.techId).travelFee : null,
      notes: r.notes, preferTechId: r.preferTechId,
      notifiedCount: r.status === 'searching' ? eligible(r).length : r.notified.length,
      acceptedCount: r.accepted.length,
      waitingOnStudio: r.status === 'searching' && s.assign === 'owner' && r.accepted.length > 0,
      pro, studioPhone: studio(r.where.from || r.where.locationId)?.phone || null,
      expiresAt: r.when === 'now' ? new Date(Date.parse(r.createdAt) + expireMs).toISOString() : r.when,
    };
  }

  // A pro sees the full address and the client's contact only once the job is theirs.
  function jobView(r, techId) {
    const mine = r.techId === techId;
    const { travelFee, payout, total } = payoutFor(r, techId);
    return {
      id: r.id, status: r.status, createdAt: r.createdAt, mine,
      accepted: r.accepted.some((a) => a.techId === techId),
      serviceName: r.serviceName, priceLabel: r.priceLabel, price: r.price, minutes: r.minutes, when: r.when,
      where: r.where.type === 'house'
        ? { type: 'house', distanceMi: r.where.distanceMi, address: mine ? r.where.address : null, lat: mine ? r.where.lat : null, lng: mine ? r.where.lng : null }
        : { type: 'studio', locationId: r.where.locationId, address: studio(r.where.locationId)?.address },
      notes: r.notes, travelFee, payout, total,
      client: mine ? r.client : { name: r.client.name },
      forYou: r.preferTechId === techId,
    };
  }

  function ownerView(r) {
    const base = jobView(r, r.techId || '');
    return {
      ...base, mine: false,
      where: r.where, client: r.client,
      techId: r.techId, techName: techName(r.techId),
      accepted: r.accepted.map((a) => ({ ...a, name: techName(a.techId), payout: payoutFor(r, a.techId).payout })),
      declined: r.declined.map(techName),
      waiting: r.status === 'searching' ? eligible(r).map(techName) : [],
      preferTechName: techName(r.preferTechId),
      payout: r.techId ? payoutFor(r, r.techId).payout : null,
      closedAt: r.closedAt || null,
    };
  }

  // ----- actions -----
  const find = (id) => db.requests.find((r) => r.id === id);
  const err = (status, message) => Object.assign(new Error(message), { status });

  function accept(r, techId) {
    if (r.status !== 'searching') throw err(409, r.techId === techId ? 'This job is already yours' : 'Someone else took this one');
    const why = blocker(r, techId);
    if (why && !(why === 'declined')) throw err(409, `You can’t take this one: ${why}`);
    r.declined = r.declined.filter((id) => id !== techId);
    if (!r.accepted.some((a) => a.techId === techId)) r.accepted.push({ techId, at: new Date().toISOString() });
    if (settings().assign === 'first') confirm(r, techId);
    save();
  }
  function confirm(r, techId) {
    r.techId = techId; r.status = 'confirmed'; r.confirmedAt = new Date().toISOString();
  }

  return {
    settings, oncallOf, sweep, create, find, eligible, blocker,
    clientView, jobView, ownerView,
    jobsFor(techId) {
      sweep();
      const open = db.requests.filter((r) => r.status === 'searching' && (!blocker(r, techId) || r.accepted.some((a) => a.techId === techId)));
      const mine = db.requests.filter((r) => r.techId === techId && ['confirmed', 'done'].includes(r.status)).slice(0, 20);
      return { oncall: oncallOf(techId), open: open.map((r) => jobView(r, techId)), mine: mine.map((r) => jobView(r, techId)) };
    },
    ownerJobs() {
      sweep();
      return {
        settings: settings(),
        team: brand.techs.map((t) => ({ id: t.id, name: t.name, ...oncallOf(t.id) })),
        requests: db.requests.slice(0, 50).map(ownerView),
      };
    },
    setOncall(techId, body) {
      const cur = oncallOf(techId);
      const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
      db.oncall[techId] = {
        on: body.on != null ? !!body.on : cur.on,
        houseCalls: body.houseCalls != null ? !!body.houseCalls : cur.houseCalls,
        radiusMi: num(body.radiusMi ?? cur.radiusMi, 1, 50, cur.radiusMi),
        travelFee: num(body.travelFee ?? cur.travelFee, 0, 200, cur.travelFee),
        minimum: num(body.minimum ?? cur.minimum, 0, 500, cur.minimum),
        takes: ['now', 'later', 'both'].includes(body.takes) ? body.takes : cur.takes,
      };
      save();
      return oncallOf(techId);
    },
    setSettings(body) {
      if (['first', 'owner'].includes(body.assign)) db.settings.assign = body.assign;
      if (Number.isFinite(Number(body.payoutPct))) db.settings.payoutPct = Math.min(90, Math.max(30, Math.round(Number(body.payoutPct))));
      // Switching to "first to accept" hands waiting jobs to whoever accepted first.
      if (settings().assign === 'first') for (const r of db.requests) if (r.status === 'searching' && r.accepted.length) confirm(r, r.accepted[0].techId);
      save();
      return settings();
    },
    accept,
    decline(r, techId) {
      if (r.status !== 'searching') return;
      r.accepted = r.accepted.filter((a) => a.techId !== techId);
      if (!r.declined.includes(techId)) r.declined.push(techId);
      save();
    },
    assign(r, techId) {
      if (r.status !== 'searching') throw err(409, 'This request is no longer open');
      if (!r.accepted.some((a) => a.techId === techId)) throw err(409, 'Only a pro who accepted can be given the job');
      confirm(r, techId); save();
    },
    done(r, techId) {
      if (r.status !== 'confirmed' || (techId && r.techId !== techId)) throw err(409, 'Only the booked pro can finish this job');
      r.status = 'done'; r.closedAt = new Date().toISOString(); save();
    },
    cancel(r, by) {
      if (!['searching', 'confirmed'].includes(r.status)) throw err(409, 'This request is already closed');
      r.status = 'cancelled'; r.cancelledBy = by; r.closedAt = new Date().toISOString(); save();
    },
    // Public pages show who is on call right now, nothing else.
    onCallNow: () => brand.techs.filter((t) => {
      const oc = oncallOf(t.id);
      const busy = db.requests.some((r) => r.status === 'confirmed' && r.techId === t.id && r.when === 'now');
      return oc.on && oc.takes !== 'later' && !busy;
    }).map((t) => t.id),
  };
}
