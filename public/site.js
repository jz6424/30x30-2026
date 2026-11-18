// Confessionail public site: home, nail artist pages, locations.
// Reads /api/public (approved sets only) and refreshes every few seconds, so a
// set Tina approves in /studio shows up here without a reload.

const $page = document.getElementById('page');
let data = null;
let seen = new Set(); // set ids already shown, to mark new arrivals
let lastSig = '';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const techOf = (id) => data.techs.find((t) => t.id === id);
const locOf = (id) => data.locations.find((l) => l.id === id);
const directions = (l) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(l.address)}`;
const bookingReady = () => data.brand.bookingUrl && !data.brand.bookingUrl.includes('{{');

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3000);
}
function bookAttrs() {
  return bookingReady() ? `href="${esc(data.brand.bookingUrl)}" target="_blank" rel="noopener"` : 'href="#" data-book';
}

// ---------- pieces ----------
function workCard(set, { small = false } = {}) {
  const hero = set.photos[0];
  const tech = techOf(set.techId);
  const fresh = seen.size && !seen.has(set.id) ? 'fresh' : '';
  return `<button type="button" class="work ${fresh}" data-set="${set.id}">
    <div class="ph"><img src="${hero.url}" alt="${esc(set.service || 'Nail set')} by ${esc(set.tech)}" loading="lazy">${set.photos.length > 1 && !small ? `<span class="count">${set.photos.length}</span>` : ''}</div>
    <div class="meta"><div class="t">${esc(set.service || 'Nail set')}</div>${small ? '' : `<div class="s">${esc([...set.details].slice(0, 2).join(' · ') || 'by ' + (tech?.name || set.tech))}</div>`}</div>
  </button>`;
}
function gallery(sets, emptyText) {
  return sets.length ? `<div class="gallery">${sets.map((s) => workCard(s)).join('')}</div>` : `<div class="empty">${esc(emptyText)}</div>`;
}
function artistCard(t) {
  const sets = data.gallery.filter((g) => g.techId === t.id).slice(0, 3);
  return `<a class="artist" href="/tech/${t.id}" data-link>
    <div class="mono">${esc(t.name[0])}</div>
    <div><div class="n">${esc(t.name)}</div><div class="sp">${esc(t.specialties.slice(0, 3).join(', '))}</div></div>
    <div class="thumbs">${sets.map((s) => `<img src="${s.photos[0].url}" alt="">`).join('')}</div>
  </a>`;
}
function placeCard(l, { withGallery = false } = {}) {
  if (l.status !== 'open') {
    return `<div class="place soon-card"><span class="soon">Coming soon</span><h3>${esc(l.name)}</h3><p class="muted">${esc(l.hoursDetail)}. Follow <a href="${esc(data.brand.instagramUrl)}" target="_blank" rel="noopener">${esc(data.brand.handle)}</a> for the opening date.</p></div>`;
  }
  const sets = data.gallery.filter((g) => g.locationId === l.id);
  return `<div class="place">
    <span class="open">${esc(l.hours)}</span>
    <h3>${esc(l.name)}</h3>
    <p class="muted">${esc(l.address)}<br>${esc(l.hoursDetail)}${l.phone ? `<br><a href="tel:${l.phone.replace(/\D/g, '')}">${esc(l.phone)}</a>` : ''}</p>
    <div class="row"><a class="btn" ${bookAttrs()}>Book</a><a class="btn btn-line" href="${directions(l)}" target="_blank" rel="noopener">Directions</a></div>
    ${withGallery ? (sets.length ? `<div class="strip">${sets.map((s) => workCard(s, { small: true })).join('')}</div>` : '<p class="muted small">New work from this studio shows up here</p>') : ''}
  </div>`;
}

// ---------- pages ----------
function home() {
  const latest = data.gallery[0];
  const [tagline] = data.brand.taglines;
  return `
    <div class="hero">
      <div style="display:grid;gap:20px">
        <span class="open">Open now · 24 hours</span>
        <h1>${esc(tagline)}</h1>
        <p class="lede">A nail studio in the Historic Core of Downtown LA. Walk in 9am to 8pm, or book any hour after that.</p>
        <div class="actions"><a class="btn" ${bookAttrs()}>Book an appointment</a><a class="btn btn-line" href="/request" data-link>Request an artist</a></div>
        <a class="oncall-line" href="/request" data-link><span class="${onCallCount() ? 'open' : 'soon'}">${onCallLine()}</span>${onCallCount() ? '<span>Get nails now, at the studio or at your place</span>' : '<span>Request a time and we’ll find you an artist</span>'}</a>
      </div>
      ${latest ? `<div class="hero-photo" data-set="${latest.id}"><img src="${latest.photos[0].url}" alt="Latest set from the studio"><div class="caption-chip"><b>${esc(latest.service || 'Latest set')}</b> · by ${esc(techOf(latest.techId)?.name || latest.tech)}</div></div>` : ''}
    </div>
    <section id="work">
      <div class="head"><h2>Latest work</h2></div>
      ${gallery(data.gallery.slice(0, 12), 'New sets from the studio appear here as soon as they’re approved')}
    </section>
    <section id="artists">
      <div class="head"><h2>Nail artists</h2></div>
      <div class="artists">${data.techs.map(artistCard).join('')}</div>
    </section>
    <section id="visit">
      <div class="head"><h2>Visit</h2><a href="/locations" data-link>Map</a></div>
      <div class="places">${data.locations.map((l) => placeCard(l)).join('')}</div>
    </section>`;
}

function techPage(id) {
  const t = techOf(id);
  if (!t) return notFound();
  const sets = data.gallery.filter((g) => g.techId === t.id);
  return `
    <a class="back" href="/#artists" data-link>‹ All artists</a>
    <div class="profile">
      <div class="top"><div class="mono big">${esc(t.name[0])}</div><div><h1>${esc(t.name)}</h1><p class="muted">Nail artist · ${esc(locOf('dtla')?.name || 'DTLA')}</p>${(data.onCall || []).includes(t.id) ? '<span class="open" style="margin-top:4px">On call now</span>' : ''}</div></div>
      <p class="bio">${esc(t.bio)}</p>
      <div class="tags">${t.specialties.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>
      <div class="actions">
        <a class="btn" ${bookAttrs()}>Book with ${esc(t.name)}</a>
        <a class="btn btn-line" href="/request?pro=${t.id}" data-link>Request ${esc(t.name)}</a>
        <a class="btn btn-line" href="${esc(t.instagram ? 'https://www.instagram.com/' + t.instagram.replace('@', '') : data.brand.instagramUrl)}" target="_blank" rel="noopener">Instagram</a>
      </div>
    </div>
    <section>
      <div class="head"><h2>${esc(t.name)}’s work</h2><span class="muted small">${sets.length} set${sets.length === 1 ? '' : 's'}</span></div>
      ${gallery(sets, `${t.name}’s approved sets appear here`)}
    </section>`;
}

function locationsPage() {
  return `
    <section style="border:0">
      <div class="head"><h1 style="font-size:40px">Visit</h1></div>
      <div class="map" id="map"><div class="fallback">Loading map…</div></div>
      <div class="places">${data.locations.map((l) => placeCard(l, { withGallery: true })).join('')}</div>
    </section>`;
}

function notFound() {
  return `<section style="border:0"><h1>Page not found</h1><p class="muted" style="margin:12px 0 20px">That page doesn’t exist.</p><a class="btn" href="/" data-link>Go to the home page</a></section>`;
}

// ---------- map (Leaflet + OpenStreetMap, loaded only on the locations page) ----------
let leaflet;
function loadLeaflet() {
  if (leaflet) return leaflet;
  leaflet = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = '/vendor/leaflet/leaflet.js';
    js.onload = () => resolve(window.L); js.onerror = reject;
    document.head.appendChild(js);
  });
  return leaflet;
}
async function drawMap() {
  const el = document.getElementById('map');
  if (!el) return;
  const open = data.locations.filter((l) => l.lat && l.lng);
  try {
    const L = await loadLeaflet();
    if (!document.body.contains(el)) return;
    el.innerHTML = '';
    const map = L.map(el, { scrollWheelZoom: false, attributionControl: true }).setView([open[0].lat, open[0].lng], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    const icon = L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    for (const l of open) {
      L.marker([l.lat, l.lng], { icon }).addTo(map)
        .bindPopup(`<b>Confessionail Studio</b><br>${esc(l.address)}<br>${esc(l.hours)}<br><a href="${directions(l)}" target="_blank" rel="noopener">Directions</a>`)
        .openPopup();
    }
  } catch {
    el.innerHTML = `<div class="fallback"><div><b>${esc(open[0]?.address || '')}</b><br><a href="${open[0] ? directions(open[0]) : '#'}" target="_blank" rel="noopener">Open in Maps</a></div></div>`;
  }
}

// ---------- set sheet ----------
function openSet(id) {
  const set = data.gallery.find((g) => g.id === id);
  if (!set) return;
  const t = techOf(set.techId);
  const wrap = document.getElementById('sheet');
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(set.service || 'Nail set')}">
    <button class="close" aria-label="Close" data-close>✕</button>
    <div class="slides" id="slides">${set.photos.map((p, i) => `<img src="${p.url}" alt="Photo ${i + 1} of ${set.photos.length}">`).join('')}</div>
    ${set.photos.length > 1 ? `<div class="dots" id="dots">${set.photos.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
    <div class="body">
      <h2>${esc(set.service || 'Nail set')}</h2>
      ${set.details.length ? `<p class="muted">${esc(set.details.join(' · '))}</p>` : ''}
      <p class="small">by ${t ? `<a href="/tech/${t.id}" data-link>${esc(t.name)}</a>` : esc(set.tech)} · ${esc(locOf(set.locationId)?.name || '')}</p>
      <a class="btn" ${bookAttrs()} style="margin-top:8px">${t ? `Book with ${esc(t.name)}` : 'Book this look'}</a>
    </div>
  </div>`;
  wrap.hidden = false;
  document.body.style.overflow = 'hidden';
  const slides = document.getElementById('slides');
  slides.onscroll = () => {
    const i = Math.round(slides.scrollLeft / slides.clientWidth);
    document.querySelectorAll('#dots i').forEach((d, j) => d.classList.toggle('on', i === j));
  };
}
function closeSet() {
  const wrap = document.getElementById('sheet');
  wrap.hidden = true; wrap.innerHTML = ''; document.body.style.overflow = '';
}

// ---------- on-demand requests ("Uber-style") ----------
// A client asks for a service now or at a set time, at the studio or at their place.
// Artists who are on call see it in /studio and accept; this page follows it live.
const myRequests = () => { try { return JSON.parse(localStorage.getItem('requests') || '{}'); } catch { return {}; } };
const rememberRequest = (id, token) => localStorage.setItem('requests', JSON.stringify({ ...myRequests(), [id]: token }));
const fmtMins = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`);
const fmtWhen = (iso) => {
  if (iso === 'now') return 'As soon as possible';
  const d = new Date(iso), now = new Date();
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === tmr.toDateString()) return `Tomorrow, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
};
const onCallCount = () => (data.onCall || []).length;
const onCallLine = () => {
  const n = onCallCount();
  return n ? `${n} artist${n === 1 ? '' : 's'} on call now` : 'No one on call right now';
};

const form = { serviceId: null, option: null, when: 'now', at: '', where: 'studio', address: '', lat: null, lng: null, pro: null, name: '', phone: '', notes: '', error: '', sending: false };

function requestPage() {
  const params = new URLSearchParams(location.search);
  if (params.get('pro') && !form.pro) form.pro = params.get('pro');
  const svc = data.services.find((s) => s.id === form.serviceId);
  const opt = svc?.options?.find((o) => o.id === form.option);
  const minutes = opt?.minutes || svc?.minutes;
  const price = opt?.price || svc?.price;
  const groups = [...new Set(data.services.map((s) => s.group))];
  const canDo = (t) => !form.serviceId || !t.serviceIds || t.serviceIds.includes(form.serviceId);
  const active = Object.keys(myRequests());
  const minAt = new Date(Date.now() + 30 * 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

  return `
    <section style="border:0;padding-bottom:16px">
      <span class="${onCallCount() ? 'open' : 'soon'}">${onCallLine()}</span>
      <h1 style="margin-top:12px">Request an artist</h1>
      <p class="lede muted" style="margin-top:12px">Tell us what you’d like. Artists on call get your request right away, and you’ll see here who’s coming.</p>
      ${active.length ? `<p class="small" style="margin-top:12px"><a href="/request/${active[active.length - 1]}" data-link>See your last request</a></p>` : ''}
    </section>
    <form id="req" class="req" novalidate>
      <h3>Service</h3>
      ${groups.map((g) => `<div class="req-group">${esc(g)}</div><div class="picklist">${data.services.filter((s) => s.group === g).map((s) => `
        <label class="pickrow ${form.serviceId === s.id ? 'on' : ''}"><input type="radio" name="svc" value="${s.id}" ${form.serviceId === s.id ? 'checked' : ''}><span class="n">${esc(s.name)}</span><span class="p">${esc(s.price)}</span></label>`).join('')}</div>`).join('')}
      ${svc?.options ? `<div class="chiprow" data-group="option">${svc.options.map((o) => `<button type="button" class="pill ${form.option === o.id ? 'on' : ''}" data-v="${o.id}">${esc(o.label)}${o.price ? ` · ${esc(o.price)}` : ''}</button>`).join('')}</div>` : ''}

      <h3>When</h3>
      <div class="chiprow" data-group="when"><button type="button" class="pill ${form.when === 'now' ? 'on' : ''}" data-v="now">As soon as possible</button><button type="button" class="pill ${form.when === 'later' ? 'on' : ''}" data-v="later">Pick a time</button></div>
      ${form.when === 'later' ? `<input class="field" type="datetime-local" id="at" min="${minAt}" value="${esc(form.at)}" aria-label="Date and time">` : ''}

      <h3>Where</h3>
      <div class="chiprow" data-group="where"><button type="button" class="pill ${form.where === 'studio' ? 'on' : ''}" data-v="studio">At the studio</button><button type="button" class="pill ${form.where === 'house' ? 'on' : ''}" data-v="house">Come to me</button></div>
      ${form.where === 'studio' ? `<p class="muted small" style="margin-top:8px">${esc(locOf('dtla')?.address || '')}</p>` : `
        <input class="field" id="address" placeholder="Home, hotel or office address" autocomplete="street-address" value="${esc(form.address)}">
        <button type="button" class="btn btn-line btn-small" id="locate" style="margin-top:8px">${form.lat != null ? 'Location added ✓' : 'Use my current location'}</button>
        <p class="muted small" style="margin-top:8px">Your artist adds a travel fee, usually $15 to $40. They only see your address once they’re booked</p>`}

      <h3>Artist</h3>
      <div class="chiprow" data-group="pro"><button type="button" class="pill ${!form.pro ? 'on' : ''}" data-v="">Anyone available</button>${data.techs.map((t) => `<button type="button" class="pill ${form.pro === t.id ? 'on' : ''}" data-v="${t.id}" ${canDo(t) ? '' : 'disabled'}>${(data.onCall || []).includes(t.id) ? '<i class="live"></i>' : ''}${esc(t.name)}</button>`).join('')}</div>

      <h3>Your details</h3>
      <input class="field" id="name" placeholder="First name" autocomplete="given-name" value="${esc(form.name)}">
      <input class="field" id="phone" type="tel" placeholder="Phone number" autocomplete="tel" value="${esc(form.phone)}">
      <textarea class="field" id="notes" rows="2" placeholder="Anything we should know? Shape, length, a reference photo you’ll bring">${esc(form.notes)}</textarea>

      <div class="summary">
        ${svc ? `<div><span>${esc(svc.name)}${opt ? `, ${esc(opt.label.toLowerCase())}` : ''}</span><b>${esc(price)}</b></div><div class="muted small"><span>About ${fmtMins(minutes || 60)}${form.where === 'house' ? ' · plus travel fee' : ''}</span></div>` : '<div class="muted">Pick a service to see the price</div>'}
      </div>
      <p class="form-error" role="alert">${esc(form.error)}</p>
      <button class="btn" id="send" style="width:100%" ${form.sending ? 'disabled' : ''}>${form.sending ? 'Sending…' : 'Send request'}</button>
      <p class="muted small" style="margin-top:12px;text-align:center">${esc(data.onDemandNote || '')}</p>
    </form>`;
}

function bindRequestForm() {
  const el = document.getElementById('req');
  if (!el) return;
  const keep = () => { for (const k of ['name', 'phone', 'notes', 'address', 'at']) { const i = document.getElementById(k); if (i) form[k] = i.value; } };
  const redraw = () => { keep(); const y = window.scrollY; $page.innerHTML = requestPage(); bindRequestForm(); window.scrollTo(0, y); };
  el.addEventListener('change', (e) => {
    if (e.target.name === 'svc') {
      form.serviceId = e.target.value; form.option = null; form.error = '';
      const t = data.techs.find((x) => x.id === form.pro);
      if (t?.serviceIds && !t.serviceIds.includes(form.serviceId)) form.pro = null;
      redraw();
    }
  });
  el.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-group] [data-v]');
    if (pill) {
      const g = pill.closest('[data-group]').dataset.group;
      form[g] = pill.dataset.v || null; form.error = '';
      if (g === 'when' && form.when === 'later' && !form.at) {
        const d = new Date(Date.now() + 2 * 3600_000); d.setMinutes(0, 0, 0);
        form.at = new Date(d - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
      }
      return redraw();
    }
    if (e.target.closest('#locate')) {
      if (!navigator.geolocation) return toast('This browser can’t share your location. Type the address instead');
      e.target.closest('#locate').textContent = 'Finding you…';
      navigator.geolocation.getCurrentPosition(
        (p) => { form.lat = Math.round(p.coords.latitude * 1e4) / 1e4; form.lng = Math.round(p.coords.longitude * 1e4) / 1e4; redraw(); },
        () => { toast('Couldn’t get your location. Type the address instead'); redraw(); },
        { timeout: 10000, maximumAge: 60000 },
      );
    }
  });
  el.addEventListener('submit', async (e) => {
    e.preventDefault(); keep();
    const svc = data.services.find((s) => s.id === form.serviceId);
    const need = !svc ? 'Pick a service'
      : svc.options && !form.option ? `Pick ${svc.options.map((o) => o.label.toLowerCase()).join(' or ')}`
      : form.when === 'later' && !form.at ? 'Pick a date and time'
      : form.where === 'house' && !form.address.trim() && form.lat == null ? 'Add the address, or use your current location'
      : !form.name.trim() ? 'Add your first name'
      : form.phone.replace(/\D/g, '').length < 10 ? 'Add a phone number so your artist can reach you' : '';
    if (need) { form.error = need; return redraw(); }
    form.sending = true; form.error = ''; redraw();
    try {
      const res = await fetch('/api/requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceId: form.serviceId, option: form.option,
          when: form.when === 'now' ? 'now' : new Date(form.at).toISOString(),
          where: form.where === 'house' ? { type: 'house', address: form.address, lat: form.lat, lng: form.lng } : { type: 'studio', locationId: 'dtla' },
          preferTechId: form.pro, notes: form.notes, client: { name: form.name, phone: form.phone },
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Couldn’t send. Try again');
      rememberRequest(json.request.id, json.token);
      Object.assign(form, { serviceId: null, option: null, notes: '', sending: false });
      go(`/request/${json.request.id}`);
    } catch (err) { form.sending = false; form.error = err.message; redraw(); }
  });
}

// ----- live status of one request -----
let watching = null;
function statusPage(id) {
  const token = myRequests()[id];
  if (!token) return `<section style="border:0"><h1>Request not found</h1><p class="muted" style="margin:12px 0 20px">Open it on the phone you sent it from, or call the studio.</p><a class="btn" href="/request" data-link>Make a new request</a></section>`;
  return `<section style="border:0" id="rq"><div class="spinner-dot"></div></section>`;
}
async function watchRequest(id) {
  const token = myRequests()[id];
  if (!token) return;
  clearInterval(watching);
  let lastSig = '';
  const tick = async () => {
    const el = document.getElementById('rq');
    if (!el) return clearInterval(watching);
    try {
      const res = await fetch(`/api/requests/${id}?t=${token}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      const sig = JSON.stringify(json.request);
      if (sig !== lastSig) { lastSig = sig; el.innerHTML = statusHtml(json.request); }
      if (['done', 'cancelled', 'expired'].includes(json.request.status)) clearInterval(watching);
    } catch (err) { el.innerHTML = `<p class="muted">${esc(err.message || 'Couldn’t load your request')}</p>`; }
  };
  await tick();
  watching = setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 3000);
}
function statusHtml(r) {
  const pro = r.pro?.name;
  const loc = locOf(r.where.locationId || 'dtla');
  const head = {
    searching: r.waitingOnStudio
      ? { cls: 'wait', t: 'An artist said yes', s: 'The studio is confirming who takes it. This usually takes a minute or two' }
      : r.notifiedCount
        ? { cls: 'wait', t: 'Finding your artist', s: `Sent to ${r.notifiedCount} artist${r.notifiedCount === 1 ? '' : 's'} on call. We’ll keep looking until ${new Date(r.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` }
        : { cls: 'wait', t: 'Waiting for an artist', s: 'No one on call can take this right now. It goes to the next artist who comes on call, or call the studio' },
    confirmed: { cls: 'ok', t: `${pro} is booked`, s: r.where.type === 'house' ? `${pro} has your address and number and will text you before heading over` : `See you at ${loc?.address || 'the studio'}. ${pro} has your number if anything changes` },
    done: { cls: 'ok', t: 'All done', s: `Thanks for coming to Confessionail${pro ? `. ${pro} would love a tag on Instagram` : ''}` },
    cancelled: { cls: 'off', t: 'Request cancelled', s: 'Nothing was charged' },
    expired: { cls: 'off', t: 'No one could take it in time', s: 'Try a later time, or call the studio and we’ll fit you in' },
  }[r.status];
  const travel = r.where.type === 'house' ? (r.travelFee != null ? ` + $${r.travelFee} travel` : ' + travel fee') : '';
  return `
    <div class="rq-head ${head.cls}">${head.cls === 'wait' ? '<div class="pulse"><i></i></div>' : ''}<h1>${esc(head.t)}</h1><p class="muted">${esc(head.s)}</p></div>
    <div class="place rq-card">
      <div class="facts">
        <div><span>Service</span><b>${esc(r.serviceName)}</b></div>
        <div><span>Price</span><b>${esc(r.priceLabel)}${travel}</b></div>
        <div><span>Takes</span><b>About ${fmtMins(r.minutes)}</b></div>
        <div><span>When</span><b>${esc(fmtWhen(r.when))}</b></div>
        <div><span>Where</span><b>${r.where.type === 'house' ? esc(r.where.address) : esc(loc?.address || 'The studio')}</b></div>
        ${pro ? `<div><span>Artist</span><b><a href="/tech/${r.pro.id}" data-link>${esc(pro)}</a></b></div>` : ''}
        ${r.notes ? `<div><span>Notes</span><b>${esc(r.notes)}</b></div>` : ''}
      </div>
    </div>
    <div class="rq-actions">
      ${r.status === 'confirmed' && r.where.type === 'studio' && loc ? `<a class="btn" href="${directions(loc)}" target="_blank" rel="noopener">Directions</a>` : ''}
      ${['expired', 'cancelled', 'done'].includes(r.status) ? '<a class="btn" href="/request" data-link>New request</a>' : ''}
      ${r.studioPhone ? `<a class="btn btn-line" href="tel:${r.studioPhone.replace(/\D/g, '')}">Call the studio</a>` : ''}
      ${['searching', 'confirmed'].includes(r.status) ? `<button type="button" class="btn btn-line" data-cancel="${r.id}">Cancel request</button>` : ''}
    </div>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cancel]');
  if (!b) return;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again to cancel'; return; }
  b.disabled = true;
  const id = b.dataset.cancel;
  try {
    const res = await fetch(`/api/requests/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: myRequests()[id] }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Couldn’t cancel');
    watchRequest(id);
  } catch (err) { toast(err.message); b.disabled = false; }
});

// ---------- router ----------
function render() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  let html;
  if (path === '/') html = home();
  else if (path === '/locations') html = locationsPage();
  else if (path.startsWith('/tech/')) html = techPage(decodeURIComponent(path.split('/')[2]));
  else if (path === '/request') html = requestPage();
  else if (path.startsWith('/request/')) html = statusPage(decodeURIComponent(path.split('/')[2]));
  else html = notFound();
  $page.innerHTML = html;
  document.querySelectorAll('.nav nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === path));
  document.getElementById('book-top').outerHTML = `<a class="btn btn-small" id="book-top" ${bookAttrs()}>Book</a>`;
  document.getElementById('foot').innerHTML = `
    <div><b style="font-family:var(--serif);font-size:17px;color:var(--ink);font-weight:500">${esc(data.brand.name)}</b></div>
    <div>${esc(data.brand.address)} · Open 24 hours</div>
    <div><a href="${esc(data.brand.instagramUrl)}" target="_blank" rel="noopener">${esc(data.brand.handle)}</a> · <a href="/studio">Staff</a></div>`;
  if (path === '/locations') drawMap();
  if (path === '/request') bindRequestForm();
  if (path.startsWith('/request/')) watchRequest(decodeURIComponent(path.split('/')[2]));
  for (const g of data.gallery) seen.add(g.id);
}

function go(href) {
  const url = new URL(href, location.origin);
  if (url.pathname + url.search !== location.pathname + location.search) {
    history.pushState({}, '', url.pathname + url.search + url.hash);
    closeSet(); render(); window.scrollTo(0, 0);
  }
  if (url.hash) document.getElementById(url.hash.slice(1))?.scrollIntoView({ behavior: 'smooth' });
}

document.addEventListener('click', (e) => {
  const set = e.target.closest('[data-set]');
  if (set) { e.preventDefault(); return openSet(set.dataset.set); }
  if (e.target.closest('[data-close]') || e.target.id === 'sheet') return closeSet();
  if (e.target.closest('[data-book]')) { e.preventDefault(); return toast('Online booking link coming soon. Call or walk in, we’re open 24 hours'); }
  const a = e.target.closest('a[data-link], a[data-scroll]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute('href')); }
});
window.addEventListener('popstate', () => { closeSet(); render(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSet(); });

// ---------- data + live refresh ----------
async function load() {
  const res = await fetch('/api/public', { headers: { 'bypass-tunnel-reminder': '1' }, cache: 'no-store' });
  return res.json();
}
(async function boot() {
  data = await load();
  lastSig = JSON.stringify([data.onCall, data.gallery.map((g) => [g.id, g.photos.map((p) => p.url)])]);
  render();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const next = await load();
      const sig = JSON.stringify([next.onCall, next.gallery.map((g) => [g.id, g.photos.map((p) => p.url)])]);
      if (sig === lastSig) return;
      lastSig = sig; data = next;
      // Re-render in place; keep scroll, leave an open sheet alone.
      if (document.getElementById('sheet').hidden && !location.pathname.startsWith('/request')) {
        const y = window.scrollY; render(); window.scrollTo(0, y);
      }
    } catch {}
  }, 4000);
})();
