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
        <div class="actions"><a class="btn" ${bookAttrs()}>Book an appointment</a><a class="btn btn-line" href="#work" data-scroll="work">See the work</a></div>
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
      <div class="top"><div class="mono big">${esc(t.name[0])}</div><div><h1>${esc(t.name)}</h1><p class="muted">Nail artist · ${esc(locOf('dtla')?.name || 'DTLA')}</p></div></div>
      <p class="bio">${esc(t.bio)}</p>
      <div class="tags">${t.specialties.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>
      <div class="actions">
        <a class="btn" ${bookAttrs()}>Book with ${esc(t.name)}</a>
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

// ---------- router ----------
function render() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  let html;
  if (path === '/') html = home();
  else if (path === '/locations') html = locationsPage();
  else if (path.startsWith('/tech/')) html = techPage(decodeURIComponent(path.split('/')[2]));
  else html = notFound();
  $page.innerHTML = html;
  document.querySelectorAll('.nav nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === path));
  document.getElementById('book-top').outerHTML = `<a class="btn btn-small" id="book-top" ${bookAttrs()}>Book</a>`;
  document.getElementById('foot').innerHTML = `
    <div><b style="font-family:var(--serif);font-size:17px;color:var(--ink);font-weight:500">${esc(data.brand.name)}</b></div>
    <div>${esc(data.brand.address)} · Open 24 hours</div>
    <div><a href="${esc(data.brand.instagramUrl)}" target="_blank" rel="noopener">${esc(data.brand.handle)}</a> · <a href="/studio">Staff</a></div>`;
  if (path === '/locations') drawMap();
  for (const g of data.gallery) seen.add(g.id);
}

function go(href) {
  const url = new URL(href, location.origin);
  if (url.pathname !== location.pathname) {
    history.pushState({}, '', url.pathname + url.hash);
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
  lastSig = JSON.stringify(data.gallery.map((g) => [g.id, g.photos.map((p) => p.url)]));
  render();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      const next = await load();
      const sig = JSON.stringify(next.gallery.map((g) => [g.id, g.photos.map((p) => p.url)]));
      if (sig === lastSig) return;
      lastSig = sig; data = next;
      // Re-render in place; keep scroll, leave an open sheet alone.
      if (document.getElementById('sheet').hidden) {
        const y = window.scrollY; render(); window.scrollTo(0, y);
      }
    } catch {}
  }, 4000);
})();
