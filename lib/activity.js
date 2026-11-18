// What the team has been doing, for the owner's Activity view. No money: counts of
// sets uploaded and approved, jobs, and time on call, per artist and per location.
export function activity(brand, db, dispatch, days) {
  const now = Date.now();
  const since = days > 0 ? now - days * 864e5 : 0;
  const inRange = (iso) => !!iso && Date.parse(iso) >= since && Date.parse(iso) <= now;
  const posts = db.posts || [], reqs = db.requests || [], log = db.oncallLog || [];
  const reqLoc = (r) => (r.where?.type === 'studio' ? r.where.locationId : 'house');
  const startOf = (r) => Date.parse(r.when === 'now' ? r.confirmedAt || r.createdAt : r.when);
  const upcoming = (r) => r.status === 'confirmed' && startOf(r) + (r.minutes || 60) * 60_000 > now;

  // Hours the On call switch was on inside the range (regular hours aren't counted).
  const hoursOn = (techId) => log.filter((e) => e.techId === techId).reduce((sum, e) => {
    const a = Math.max(since, Date.parse(e.from)), b = Math.min(now, e.to ? Date.parse(e.to) : now);
    return sum + Math.max(0, b - a);
  }, 0) / 3600e3;

  const counts = (match) => ({
    uploads: posts.filter((p) => match.post(p) && inRange(p.createdAt)).length,
    approved: posts.filter((p) => match.post(p) && ['ready', 'posted'].includes(p.status) && inRange(p.approvedAt)).length,
    jobsDone: reqs.filter((r) => match.req(r) && r.status === 'done' && inRange(r.closedAt)).length,
    upcoming: reqs.filter((r) => match.req(r) && upcoming(r)).length,
  });

  const techs = brand.techs.map((t) => {
    const c = counts({ post: (p) => p.techId === t.id, req: (r) => r.techId === t.id });
    const saidYes = reqs.filter((r) => r.accepted?.some((a) => a.techId === t.id && inRange(a.at))).length;
    const saidNo = reqs.filter((r) => r.declined?.includes(t.id) && inRange(r.createdAt)).length;
    const times = [
      ...posts.filter((p) => p.techId === t.id).map((p) => p.createdAt),
      ...reqs.flatMap((r) => (r.accepted || []).filter((a) => a.techId === t.id).map((a) => a.at)),
      ...reqs.filter((r) => r.techId === t.id && r.closedAt).map((r) => r.closedAt),
      ...log.filter((e) => e.techId === t.id).map((e) => e.from),
    ].filter(Boolean).map(Date.parse).filter((x) => x <= now);
    const oc = dispatch.oncallOf(t.id);
    return {
      id: t.id, name: t.name, active: t.active !== false, sample: !!t.sample, locationIds: t.locationIds || [],
      ...c, saidYes, saidNo, hoursOnCall: Math.round(hoursOn(t.id) * 10) / 10,
      lastActive: times.length ? new Date(Math.max(...times)).toISOString() : null,
      onCallNow: oc.activeNow, oncall: oc,
    };
  });

  const locations = brand.locations.filter((l) => l.status !== 'hidden').map((l) => ({
    id: l.id, name: l.name, status: l.status,
    ...counts({ post: (p) => (p.locationId || 'dtla') === l.id, req: (r) => reqLoc(r) === l.id }),
    artists: brand.techs.filter((t) => t.active !== false && (t.locationIds || []).includes(l.id)).map((t) => t.id),
    waiting: reqs.filter((r) => r.status === 'searching' && reqLoc(r) === l.id).length,
  }));
  const houseCalls = { id: 'house', name: 'House calls', ...counts({ post: () => false, req: (r) => reqLoc(r) === 'house' }) };

  const active = techs.filter((t) => t.active);
  const total = ['uploads', 'approved', 'jobsDone', 'upcoming'].reduce((o, k) => ({ ...o, [k]: active.reduce((s, t) => s + t[k], 0) }), {});
  // Jobs and posts from artists who have left still count toward the studio total.
  total.jobsDone = reqs.filter((r) => r.status === 'done' && inRange(r.closedAt)).length;
  total.uploads = posts.filter((p) => inRange(p.createdAt)).length;
  total.approved = posts.filter((p) => ['ready', 'posted'].includes(p.status) && inRange(p.approvedAt)).length;
  total.upcoming = reqs.filter(upcoming).length;
  total.toReview = posts.filter((p) => p.status === 'needs_approval').length;
  total.onCallNow = active.filter((t) => t.onCallNow).length;
  total.artists = active.length;

  return { days, since: since ? new Date(since).toISOString() : null, total, techs, locations, houseCalls };
}
