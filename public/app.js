import { analyzeFile, markDuplicates } from './quality.js';

const $app = document.getElementById('app');
const state = {
  config: null,
  posts: [],
  upload: { techId: localStorage.getItem('techId') || '', serviceId: null, option: null, gel: false, addons: {}, menuOpen: true, results: [], analyzing: 0, sending: false },
  view: { channel: 'ig', editing: false, postsTab: 'needs_approval' },
  filesCache: {},        // postId -> File[] (prefetched so Share runs inside one tap)
  awaitingConfirm: null, // postId shared, ask "Did you post it?" on return
  taps: 0,
};

// ---------- icons (lucide, 18px, 1.5 stroke) ----------
const ICONS = {
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  images: '<path d="M18 22H4a2 2 0 0 1-2-2V6"/><path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18"/><circle cx="12" cy="8" r="2"/><rect width="16" height="16" x="6" y="2" rx="2"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  logout: '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  back: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
};
const icon = (name) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// localtunnel shows a reminder page to browsers unless this header is sent.
const TUNNEL_HEADERS = { 'bypass-tunnel-reminder': '1' };
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json', ...TUNNEL_HEADERS }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  if (res.status === 401 && json?.signIn) { showSignIn(); throw new Error('Please sign in'); }
  if (!res.ok || !json) throw new Error(json?.error || `Server error ${res.status}. Try again`);
  return json;
}
const isOwner = () => state.user?.role === 'owner';
let toastTimer;
function toast(msg, ms = 3200) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function modal(html) {
  const m = document.getElementById('modal');
  if (!html) { m.hidden = true; m.innerHTML = ''; return m; }
  m.innerHTML = `<div class="sheet">${html}</div>`; m.hidden = false;
  return m;
}
const isPhone = () => /iphone|ipad|ipod|android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /macintosh/i.test(navigator.userAgent));
const service = (id) => state.config?.brand.services.find((s) => s.id === id);
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
// Title and detail line for a set, from the tech's menu picks.
const setTitle = (p) => p.booking?.serviceName || service(p.serviceId)?.name || 'Nail set';
const setDetail = (p) => (p.booking ? [cap(p.booking.name.split(', ').slice(1).join(', ')), ...p.booking.addons.map((x) => x.name)].filter(Boolean).join(' · ') : '');
const photo = (post, id) => post.photos.find((p) => p.id === id);
const isOverdue = (p) => p.status === 'ready' && p.scheduledFor && new Date(p.scheduledFor) < new Date();
function fmtSlot(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}
function captionText(post, channel = state.view.channel) {
  const key = post.chosen;
  const edit = post.edits?.[`${key}.${channel}`];
  if (edit != null) return edit;
  return post.captions.options.find((o) => o.key === key)?.[channel] || '';
}
function setPost(updated) {
  const i = state.posts.findIndex((p) => p.id === updated.id);
  if (i >= 0) state.posts[i] = updated; else state.posts.unshift(updated);
  updateBadge();
}
function updateBadge() {
  const n = state.posts.filter((p) => p.status === 'needs_approval').length + state.posts.filter(isOverdue).length;
  const b = document.getElementById('badge');
  b.textContent = n; b.hidden = !n;
}

// ---------- clipboard + share ----------
function copyText(text) {
  // Clipboard API needs HTTPS (or localhost). Fall back to execCommand otherwise.
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}
function orderedPhotos(post) {
  return [post.heroId, ...post.carouselIds].filter(Boolean).map((id) => photo(post, id)).filter(Boolean);
}
async function prefetchFiles(post) {
  const key = post.id + ':' + [post.heroId, ...post.carouselIds].join(',');
  if (state.filesCache[post.id]?.key === key) return state.filesCache[post.id].files;
  const files = await Promise.all(orderedPhotos(post).map(async (p, i) => {
    const blob = await (await fetch(p.url, { headers: TUNNEL_HEADERS })).blob();
    return new File([blob], `confessionail-${post.id}-${i + 1}.jpg`, { type: 'image/jpeg' });
  }));
  state.filesCache[post.id] = { key, files };
  return files;
}
function canShareFiles(files) {
  return !!(navigator.share && navigator.canShare && files?.length && navigator.canShare({ files }));
}
// Runs inside the button tap: copy caption first, then open the share sheet.
function shareTo(post, channel) {
  const files = state.filesCache[post.id]?.files;
  const text = captionText(post, channel);
  copyText(text);
  if (!canShareFiles(files)) {
    toast('Caption copied. This browser can’t attach photos, so use Save photos and paste the caption', 5000);
    return;
  }
  navigator.share({ files }).then(() => {
    state.awaitingConfirm = post.id;
    // Some browsers resolve after you come back; ask now if we're visible.
    if (document.visibilityState === 'visible') setTimeout(askPosted, 400);
  }).catch((err) => {
    if (err.name !== 'AbortError') toast('The share sheet didn’t open. Try Save photos');
  });
  toast(channel === 'ig' ? 'Caption copied. Long-press to paste it in Instagram' : 'Caption copied. Paste it in Facebook', 4500);
  state.awaitingConfirm = post.id;
}
function askPosted() {
  const id = state.awaitingConfirm;
  if (!id || !document.getElementById('modal').hidden) return;
  state.awaitingConfirm = null;
  const m = modal(`<h2>Did you post it?</h2><p class="muted">Yes moves it to Posted</p>
    <div class="row"><button class="btn-ghost" data-a="no">Not yet</button><button class="btn-gold" data-a="yes">Yes, posted</button></div>`);
  m.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    modal(null);
    if (a === 'yes') {
      const { post } = await api(`/api/posts/${id}/posted`, { method: 'POST', body: { taps: flushTaps() } });
      setPost(post); toast('Moved to Posted'); render();
    }
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.awaitingConfirm) setTimeout(askPosted, 300);
});
async function savePhotos(post) {
  const cached = state.filesCache[post.id]?.files;
  // On phones the share sheet has "Save Images", which puts them in the camera roll.
  if (isPhone() && cached && canShareFiles(cached)) {
    navigator.share({ files: cached }).catch(() => {});
    return toast('Tap Save Images to put them in your photos', 4500);
  }
  const files = cached || (await prefetchFiles(post));
  for (const [i, f] of files.entries()) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    if (i < files.length - 1) await new Promise((r) => setTimeout(r, 350));
  }
  toast(`Saved ${files.length} photo${files.length > 1 ? 's' : ''}`);
}

// Metrics: taps per post (counted while a post is open).
document.addEventListener('click', (e) => { if (location.hash.startsWith('#/post/') && e.target.closest('button')) state.taps++; }, true);
function flushTaps() { const t = state.taps; state.taps = 0; return t; }

// ---------- Upload (nail tech) ----------
function renderUpload() {
  const u = state.upload;
  const kept = u.results.filter((r) => !r.dropped && !r.duplicateOf);
  const tiles = u.results.map((r) => {
    let tag = `<span class="tag ok"><i class="dot"></i>${esc(r.pixelReason)}</span>`, cls = '';
    if (r.dropped) { tag = `<span class="tag bad"><i class="dot"></i>${esc(r.dropped)}</span>`; cls = 'out'; }
    else if (r.duplicateOf) { tag = `<span class="tag dup"><i class="dot"></i>Near copy, skipped</span>`; cls = 'out'; }
    return `<div class="tile ${cls}"><img src="${r.thumbUrl}" alt=""></div>`.replace('</div>', `${tag}</div>`);
  }).join('');
  $app.innerHTML = `
    <h1>New set</h1>
    <p class="muted">Add photos of one finished set. The app picks the best shots and drafts a caption, and Tina approves before anything is posted.</p>

    ${isOwner() ? `<div class="section-label">Who did this set?</div>
    <div class="chips" id="techs">${state.config.brand.techs.filter((t) => t.active !== false).map((t) => `<button type="button" class="chip ${u.techId === t.id ? 'on' : ''}" data-tech="${t.id}">${esc(t.name)}</button>`).join('')}</div>` : ''}

    ${uploadLocHtml(u)}
    ${menuHtml(u)}

    <div class="section-label">Photos</div>
    <div class="row">
      <label class="dropzone" for="cam">${icon('camera')}<b>Take photo</b></label>
      <label class="dropzone" for="file">${icon('images')}<b>Choose photos</b></label>
    </div>
    <p class="muted small" style="margin-top:8px">5 to 20 photos of the same set, nails close up on marble or white fur</p>
    <input id="cam" type="file" accept="image/*" capture="environment" hidden>
    <input id="file" type="file" accept="image/*" multiple hidden>
    ${u.analyzing ? `<p class="muted small" style="margin-top:8px">Checking ${u.analyzing} photo${u.analyzing > 1 ? 's' : ''} for blur, glare and lighting…</p>` : ''}
    ${u.results.length ? `<p class="small" style="margin:12px 0 8px"><b class="num-t">${kept.length}</b> good to use · <span class="num-t">${u.results.length - kept.length}</span> skipped</p><div class="grid">${tiles}</div>
      <button class="link" id="clear" style="margin-top:8px">Start over</button>` : ''}

    <div class="bar"><div class="inner">
      <div class="note">${!validTech(u) ? 'Pick who did the set' : !u.serviceId ? 'Pick the service first' : !kept.length ? 'Add photos of the set' : `${kept.length} photo${kept.length > 1 ? 's' : ''} ready`}</div>
      <button class="btn-primary" id="go" ${!validTech(u) || !u.serviceId || !kept.length || u.analyzing || u.sending ? 'disabled' : ''}>Pick the best shots</button>
    </div></div>`;

  if (isOwner()) document.getElementById('techs').onclick = (e) => {
    const t = e.target.closest('[data-tech]'); if (!t) return;
    u.techId = t.dataset.tech; localStorage.setItem('techId', u.techId); renderUpload();
  };
  document.getElementById('upl-loc')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-loc]'); if (!b) return;
    u.locationId = b.dataset.loc; renderUpload();
  });
  document.getElementById('menu').onclick = (e) => {
    const t = e.target.closest('[data-svc],[data-opt],[data-gel],[data-change],[data-addon],[data-aopt]');
    if (!t) return;
    const brand = state.config.brand;
    const d = t.dataset;
    if (d.svc) {
      const s = brand.services.find((x) => x.id === d.svc);
      u.serviceId = s.id; u.option = s.options?.[0]?.id || null; u.gel = false; u.menuOpen = false;
    } else if (d.opt) u.option = d.opt;
    else if (d.gel) u.gel = !u.gel;
    else if (d.change != null) u.menuOpen = true;
    else if (d.addon) {
      const next = { ...u.addons };
      if (d.addon in next) u.addons = Object.fromEntries(Object.entries(next).filter(([k]) => k !== d.addon));
      else u.addons = { ...next, [d.addon]: brand.addons.find((x) => x.id === d.addon).options?.[0]?.id || null };
    } else if (d.aopt) { const [id, opt] = d.aopt.split(':'); u.addons = { ...u.addons, [id]: opt }; }
    renderUpload();
  };
  document.getElementById('file').onchange = (e) => addFiles([...e.target.files]);
  document.getElementById('cam').onchange = (e) => addFiles([...e.target.files]);
  document.getElementById('clear')?.addEventListener('click', () => { u.results = []; renderUpload(); });
  document.getElementById('go').onclick = sendSet;
}

const validTech = (u) => !isOwner() || state.config.brand.techs.some((t) => t.id === u.techId && t.active !== false);
// Where the set was done: the artist's studio, or a choice if they work at more than one.
function uploadLocs(u) {
  const t = state.config.brand.techs.find((x) => x.id === u.techId);
  const open = state.config.brand.locations.filter((l) => l.status === 'open');
  return t?.locationIds?.length ? open.filter((l) => t.locationIds.includes(l.id)) : open;
}
function uploadLocHtml(u) {
  const locs = uploadLocs(u);
  if (!locs.some((l) => l.id === u.locationId)) u.locationId = locs[0]?.id || null;
  if (locs.length < 2) return '';
  return `<div class="section-label">Where was it done?</div><div class="chips" id="upl-loc">${locs.map((l) => `<button type="button" class="chip ${u.locationId === l.id ? 'on' : ''}" data-loc="${l.id}">${esc(l.name)}</button>`).join('')}</div>`;
}

// Two-step menu: pick one service (with its option), then any add-ons.
function menuHtml(u) {
  const { services, addons, serviceGroups, menuNote } = state.config.brand;
  const svc = services.find((s) => s.id === u.serviceId);
  const priceOf = (x) => (x.options?.every((o) => o.price) ? x.options.map((o) => o.price).join(' / ') : x.price);
  const seg = (choices, current, attr, prefix = '') => `<div class="seg mini">${choices.map((c) =>
    `<button type="button" data-${attr}="${prefix}${c.id}" class="${current === c.id ? 'on' : ''}">${esc(c.label)}${c.price ? ` <span class="price">${esc(c.price)}</span>` : ''}</button>`).join('')}</div>`;

  let step1;
  if (!svc || u.menuOpen) {
    step1 = serviceGroups.map((g) => `
      <div class="menu-group">${esc(g)}</div>
      <div class="menu">${services.filter((s) => s.group === g).map((s) => `
        <button type="button" class="menu-row ${s.id === u.serviceId ? 'on' : ''}" data-svc="${s.id}">
          <span class="name">${esc(s.name)}</span><span class="price">${esc(priceOf(s))}</span>
        </button>`).join('')}
      </div>`).join('');
  } else {
    step1 = `<div class="menu">
      <div class="menu-row picked"><span class="name">${esc(svc.name)}</span><button type="button" class="link" data-change>Change</button></div>
      ${svc.options || svc.gel ? `<div class="menu-extra">
        ${svc.options ? seg(svc.options, u.option, 'opt') : ''}
        ${svc.gel ? `<button type="button" class="check-row ${u.gel ? 'on' : ''}" data-gel="1"><span class="box"></span><span class="name">Add gel</span><span class="price">+$${svc.gel}</span></button>` : ''}
      </div>` : ''}
      ${svc.desc ? `<p class="muted small menu-desc">${esc(svc.desc)} <span class="price">${esc(svc.price)}</span></p>` : ''}
    </div>`;
  }

  const step2 = svc && !u.menuOpen ? `
    <div class="section-label">Add-ons <span class="opt-label">optional</span></div>
    <div class="menu">${addons.map((a) => {
      const on = a.id in u.addons;
      return `<button type="button" class="check-row ${on ? 'on' : ''}" data-addon="${a.id}"><span class="box"></span><span class="name">${esc(a.name)}</span><span class="price">${esc(priceOf(a))}</span></button>
        ${on && a.options ? `<div class="menu-extra">${seg(a.options, u.addons[a.id], 'aopt', a.id + ':')}</div>` : ''}`;
    }).join('')}</div>
    <p class="muted small" style="margin-top:8px">${esc(menuNote)}</p>` : '';

  return `<div id="menu">
    <div class="section-label">Service</div>
    ${step1}
    ${step2}
  </div>`;
}

async function addFiles(files) {
  const u = state.upload;
  files = files.filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
  u.analyzing += files.length; renderUpload();
  for (const f of files) {
    try {
      const r = await analyzeFile(f, `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
      u.results.push(r);
    } catch (err) {
      console.warn('Could not read', f.name, err);
      toast(`Couldn’t open ${f.name}`);
    }
    u.analyzing--;
    markDuplicates(u.results);
    if (location.hash.startsWith('#/upload') || !location.hash) renderUpload();
  }
}

// Upload one photo as raw JPEG bytes. Small requests get through tunnels and
// weak phone signal; each photo is retried once.
function uploadPhoto(dataUrl, onProgress) {
  const attempt = () => new Promise((resolve, reject) => {
    fetch(dataUrl).then((r) => r.blob()).then((blob) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      xhr.setRequestHeader('Content-Type', 'image/jpeg');
      xhr.setRequestHeader('bypass-tunnel-reminder', '1');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let json = {}; try { json = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status < 300 && json.uploadId) resolve(json.uploadId);
        else reject(new Error(json.error || `Upload failed (server said ${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Upload failed: no connection to the server'));
      xhr.ontimeout = () => reject(new Error('Upload timed out'));
      xhr.timeout = 60000;
      xhr.send(blob);
    }, reject);
  });
  return attempt().catch(() => attempt());
}

async function sendSet() {
  const u = state.upload;
  u.sending = true;
  modal(`<div style="text-align:center"><div class="spinner"></div><h2>Sending to Tina</h2><p class="muted" id="up-msg">Uploading photos…</p></div>`);
  try {
    const started = Date.now();
    const msg = (t) => { const el = document.getElementById('up-msg'); if (el) el.textContent = t; };
    const total = u.results.length;
    for (const [i, r] of u.results.entries()) {
      if (r.uploadId) continue; // already sent on an earlier try
      // Skipped photos go up as small thumbnails to save phone data.
      r.uploadId = await uploadPhoto(r.dropped || r.duplicateOf ? r.thumbUrl : r.dataUrl, (f) => msg(`Uploading photo ${i + 1} of ${total}… ${Math.round(f * 100)}%`));
    }
    msg('Saving the set');
    const { post } = await api('/api/sets', { method: 'POST', body: {
        techId: u.techId, locationId: u.locationId, serviceId: u.serviceId, option: u.option, gel: u.gel,
        addons: Object.entries(u.addons).map(([id, option]) => ({ id, option })),
        photos: u.results.map(({ id, name, uploadId, width, height, checks, features, pixelReason, dropped, duplicateOf }) => ({ id, name, uploadId, width, height, checks, features, pixelReason, dropped, duplicateOf })),
    } });
    console.info(`Set processed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    setPost(post);
    u.results = []; Object.assign(u, { serviceId: null, option: null, gel: false, addons: {}, menuOpen: true });
    modal(null);
    location.hash = `#/sent/${post.id}`;
  } catch (err) {
    for (const r of u.results) delete r.uploadId; // resend everything next time
    modal(null); toast(err.message, 6000);
  } finally {
    u.sending = false;
  }
}

function renderSent(id) {
  const post = state.posts.find((p) => p.id === id);
  if (!post) return (location.hash = '#/upload');
  const usable = post.photos.filter((p) => !p.dropped && !p.duplicateOf);
  $app.innerHTML = `
    <h1>Sent to Tina</h1>
    <p class="muted">${post.photos.length} photos saved, ${usable.length} good to use. The app picks the best shots and writes the caption on its own, so you can close this screen</p>
    <div class="grid">${usable.map((p) => `<div class="tile"><img src="${p.url}" alt=""></div>`).join('')}</div>
    <div class="bar"><div class="inner row">
      ${isOwner() ? `<a class="btn btn-ghost" href="#/post/${post.id}">Open review</a>` : ''}
      <a class="btn btn-primary" href="#/upload">Upload another set</a>
    </div></div>`;
}

// ---------- Posts (owner) ----------
function renderPosts() {
  const tab = state.view.postsTab;
  const by = (s) => state.posts.filter((p) => p.status === s);
  const overdue = state.posts.filter(isOverdue);
  let list = by(tab);
  if (tab === 'ready') list = list.sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));
  if (tab === 'posted') list = list.sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));

  const item = (p) => {
    const hero = photo(p, p.heroId) || p.photos.find((x) => !x.dropped && !x.duplicateOf) || p.photos[0];
    const s = service(p.serviceId);
    const status = p.stage === 'failed' ? `<span class="status overdue">Couldn’t get ready, tap to retry</span>`
      : p.stage ? `<span class="status posted">Getting ready</span>`
      : isOverdue(p) ? `<span class="status overdue">Overdue, ${fmtSlot(p.scheduledFor)}</span>`
      : p.status === 'ready' ? `<span class="status ready">${fmtSlot(p.scheduledFor)}</span>`
      : p.status === 'posted' ? `<span class="status posted">Posted ${new Date(p.postedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>`
      : `<span class="status needs_approval">Needs approval</span>`;
    return `<a class="card list-item" href="#/post/${p.id}">
      ${hero ? `<img src="${hero.url}" alt="">` : '<img alt="">'}
      <div class="meta"><div class="title">${esc(setTitle(p))}</div>
        <div class="muted small" style="margin-bottom:4px">${setDetail(p) ? esc(setDetail(p)) + ' · ' : ''}by ${esc(p.tech)}</div>${status}</div>
      <span class="chev">${icon('right')}</span></a>`;
  };

  const approved = state.posts.filter((p) => p.approvedAt);
  const avgSec = approved.length ? Math.round(approved.reduce((s, p) => s + (new Date(p.approvedAt) - new Date(p.createdAt)) / 1000, 0) / approved.length) : null;
  const done = state.posts.filter((p) => p.status !== 'needs_approval');
  const avgTaps = done.length ? (done.reduce((s, p) => s + (p.metrics?.taps || 0), 0) / done.length).toFixed(1) : '–';
  const fmtDur = (s) => (s == null ? '–' : s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);

  $app.innerHTML = `
    <h1>Posts</h1>
    ${overdue.length ? `<div class="card" style="border-color:rgba(163,67,59,.3)"><b>${overdue.length} post${overdue.length > 1 ? 's are' : ' is'} overdue</b>
      <div style="margin-top:12px">${overdue.map(item).join('')}</div></div>` : ''}
    <div class="seg" id="seg" style="margin-bottom:16px">
      <button data-t="needs_approval" class="${tab === 'needs_approval' ? 'on' : ''}">To review (${by('needs_approval').length})</button>
      <button data-t="ready" class="${tab === 'ready' ? 'on' : ''}">Up next (${by('ready').length})</button>
      <button data-t="posted" class="${tab === 'posted' ? 'on' : ''}">Posted (${by('posted').length})</button>
    </div>
    ${tab === 'needs_approval' && list.filter((p) => !p.stage).length > 1 ? `<button class="btn-gold" id="approve-all" style="margin-bottom:16px">Approve all ${list.filter((p) => !p.stage).length}</button>` : ''}
    ${tab === 'ready' && list.length ? `<p class="muted small">One post a day, 12 PM Mon–Thu and 7 PM Fri–Sun. These times are a guess, not data</p>` : ''}
    ${list.length ? list.map(item).join('') : `<div class="card muted" style="text-align:center">${{ needs_approval: 'Nothing to review. New sets from the team land here', ready: 'No approved posts yet', posted: 'Nothing posted yet' }[tab]}</div>`}
    <div class="section-label">So far</div>
    <div class="card stats">
      <div><b>${fmtDur(avgSec)}</b><span>upload to approved</span></div>
      <div><b>${avgTaps}</b><span>taps per post</span></div>
      <div><b>${by('posted').length}/${approved.length}</b><span>planned posts shared</span></div>
    </div>
    <p class="muted small" style="text-align:center">Photo picker: ${esc(state.config.visionProvider)}</p>
    <p class="small" style="text-align:center"><a href="/" target="_blank" style="color:var(--gold-ink)">Open the public site</a>, where approved sets appear</p>`;

  document.getElementById('seg').onclick = (e) => {
    const t = e.target.closest('[data-t]')?.dataset.t; if (!t) return;
    state.view.postsTab = t; renderPosts();
  };
  document.getElementById('approve-all')?.addEventListener('click', async () => {
    const { posts } = await api('/api/posts/approve-all', { method: 'POST' });
    state.posts = posts; updateBadge(); state.view.postsTab = 'ready';
    toast('All approved, one post a day'); renderPosts();
  });
}

function renderPost(id) {
  const post = state.posts.find((p) => p.id === id);
  if (!post) return (location.hash = '#/posts');
  if (post.stage) return renderPreparing(post);
  prefetchFiles(post).catch(() => {});
  const s = service(post.serviceId);
  const hero = photo(post, post.heroId);
  const picked = new Set([post.heroId, ...post.carouselIds]);
  const others = post.photos.filter((p) => !picked.has(p.id)).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const opt = post.captions.options.find((o) => o.key === post.chosen);
  const ch = state.view.channel;
  const text = captionText(post);
  const usable = (p) => !p.dropped && !p.duplicateOf;

  const checkRows = (p) => {
    const names = { sharpness: 'Sharp focus', glare: 'No glare', exposure: 'Lighting', framing: 'Framing', background: 'Clean background', houseStyle: 'House style' };
    return `<div class="checks">${Object.entries(names).filter(([k]) => p.checks[k] != null).map(([k, n]) => `<span>${n}</span><span class="v">${p.checks[k]}</span>`).join('')}</div>`;
  };

  const actionBar = {
    needs_approval: `<div class="note">Goes in the queue for <b>${esc(nextSlotLabel())}</b></div>
      <button class="btn-gold" data-act="approve">Approve</button>`,
    ready: `<div class="note">${isOverdue(post) ? '<b style="color:var(--bad)">Overdue</b>, was due' : 'Scheduled for'} ${fmtSlot(post.scheduledFor)}</div>
      <button class="btn-primary" data-act="share-ig">Share to Instagram</button>
      <div class="row" style="margin-top:8px"><button class="btn-ghost" data-act="save">Save photos</button><button class="btn-ghost" data-act="copy">Copy caption</button></div>`,
    posted: `<div class="note">Posted ${new Date(post.postedAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
      <div class="row"><button class="btn-ghost" data-act="save">Save photos</button><button class="btn-ghost" data-act="copy">Copy caption</button></div>`,
  }[post.status];

  $app.innerHTML = `
    <a href="#/posts" class="back">${icon('left')}All posts</a>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin:8px 0 12px">
      <h1 style="margin:0">${esc(setTitle(post))}</h1>
      <span class="status ${isOverdue(post) ? 'overdue' : post.status}">${isOverdue(post) ? 'Overdue' : { needs_approval: 'Needs approval', ready: 'Ready to post', posted: 'Posted' }[post.status]}</span>
    </div>
    <p class="muted small">${setDetail(post) ? `<span style="color:var(--ink)">${esc(setDetail(post))}</span><br>` : ''}${post.booking ? esc(post.booking.price) + ' · ' : ''}by ${esc(post.tech)} · ${post.photos.length} photos uploaded</p>

    ${hero ? `<div class="hero"><img src="${hero.url}" alt="Hero photo" data-view="${hero.url}"><span class="num first">1</span><div class="why"><span class="score">${hero.score}</span>${esc(hero.reason)}</div></div>
      <details><summary>Score breakdown</summary>${checkRows(hero)}</details>` : '<div class="card">No usable photos in this set.</div>'}
    ${post.retakeTip ? `<div class="tip" style="margin-top:12px"><b>These are a bit weak.</b> Tip for the team: ${esc(post.retakeTip)}</div>` : ''}

    <div class="section-label">Carousel, in swipe order</div>
    <div class="strip">
      ${post.carouselIds.map((pid, i) => { const p = photo(post, pid); return `<div class="pick">
        <div class="tile"><img src="${p.url}" alt="" data-view="${p.url}"><span class="num">${i + 2}</span></div>
        <div class="reason"><span class="score">${p.score}</span>${esc(p.reason)}</div>
        <div class="acts"><button class="btn-ghost" data-hero="${p.id}">Make 1st</button><button class="btn-line" data-remove="${p.id}">Remove</button></div>
      </div>`; }).join('') || '<p class="muted small">Only the first photo</p>'}
    </div>

    ${others.length ? `<details><summary>Other photos (${others.length})</summary><div class="strip" style="margin-top:8px">
      ${others.map((p) => `<div class="pick"><div class="tile ${usable(p) ? '' : 'out'}"><img src="${p.url}" alt="" data-view="${p.url}"></div>
        <div class="reason">${p.score != null && usable(p) ? `<span class="score">${p.score}</span>` : ''}${esc(p.reason || '')}</div>
        <div class="acts"><button class="btn-ghost" data-add="${p.id}">Add</button><button class="btn-line" data-hero="${p.id}">Make 1st</button></div></div>`).join('')}
    </div></details>` : ''}

    <div class="section-label">Caption</div>
    <div class="card">
      <div class="seg" id="opts">${post.captions.options.map((o) => `<button data-k="${o.key}" class="opt ${o.key === post.chosen ? 'on' : ''}"><b>${o.key}</b><small>${esc(o.label)}</small></button>`).join('')}</div>
      <div class="seg" id="chan" style="margin-top:8px"><button data-c="ig" class="${ch === 'ig' ? 'on' : ''}">Instagram</button><button data-c="fb" class="${ch === 'fb' ? 'on' : ''}">Facebook</button></div>
      ${state.view.editing
        ? `<textarea id="cap-edit" style="margin-top:12px">${esc(text)}</textarea><div class="row" style="margin-top:8px"><button class="btn-ghost" data-act="cancel-edit">Cancel</button><button class="btn-primary" data-act="save-edit">Save</button></div>`
        : `<div class="caption" id="cap">${esc(text)}</div>
           <div class="chips"><button class="chip" data-act="edit">${icon('pencil')}Edit</button><button class="chip" data-tweak="shorter">Shorter</button><button class="chip" data-tweak="playful">More playful</button><button class="chip" data-tweak="new">New options</button></div>`}
      ${post.status !== 'needs_approval' ? `<div style="margin-top:12px"><button class="btn-line" style="width:100%;min-height:44px;font-size:15px" data-act="share-fb">Share to Facebook</button></div>` : ''}
    </div>

    <div style="display:flex;justify-content:space-between;margin-top:8px">
      ${post.status === 'ready' ? '<button class="link" data-act="unapprove">Move back to review</button>' : '<span></span>'}
      ${post.status === 'ready' ? '<button class="link" data-act="mark-posted">Already posted it</button>' : ''}
      <button class="link" data-act="delete" style="color:var(--bad)">Delete set</button>
    </div>
    <p class="muted small">The app never edits photos. Instagram crops to 4:5 when you post</p>
    <div class="bar"><div class="inner">${actionBar}</div></div>`;

  $app.onclick = async (e) => {
    const v = e.target.closest('[data-view]');
    if (v) return viewPhoto(v.dataset.view);
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    try {
      if (d.hero) {
        const carousel = [post.heroId, ...post.carouselIds].filter((x) => x && x !== d.hero).slice(0, 4);
        await patch({ heroId: d.hero, carouselIds: carousel });
      } else if (d.remove) {
        await patch({ carouselIds: post.carouselIds.filter((x) => x !== d.remove) });
      } else if (d.add) {
        if (post.carouselIds.length >= 9) return toast('Instagram allows up to 10 photos');
        await patch({ carouselIds: [...post.carouselIds, d.add] });
      } else if (d.k) {
        await patch({ chosen: d.k });
      } else if (d.c) {
        state.view.channel = d.c; renderPost(id);
      } else if (d.tweak) {
        b.disabled = true; b.textContent = 'Writing…';
        const { post: p } = await api(`/api/posts/${id}/captions`, { method: 'POST', body: { tweak: d.tweak } });
        setPost(p); renderPost(id);
      } else if (d.act) {
        await act(d.act, post);
      }
    } catch (err) { toast(err.message); }
  };

  async function patch(body) {
    const { post: p } = await api(`/api/posts/${id}`, { method: 'PATCH', body });
    setPost(p); renderPost(id);
  }
  async function act(a, post) {
    if (a === 'share-ig') return shareTo(post, 'ig');
    if (a === 'share-fb') return shareTo(post, 'fb');
    if (a === 'save') return savePhotos(post);
    if (a === 'copy') { await copyText(captionText(post)); return toast('Caption copied'); }
    if (a === 'edit') { state.view.editing = true; return renderPost(id); }
    if (a === 'cancel-edit') { state.view.editing = false; return renderPost(id); }
    if (a === 'save-edit') {
      state.view.editing = false;
      return patch({ edit: { key: post.chosen, channel: state.view.channel, text: document.getElementById('cap-edit').value } });
    }
    if (a === 'approve') {
      const { post: p } = await api(`/api/posts/${id}/approve`, { method: 'POST', body: { taps: flushTaps() } });
      setPost(p); toast(`Approved for ${fmtSlot(p.scheduledFor)}`); return renderPost(id);
    }
    if (a === 'unapprove') { const { post: p } = await api(`/api/posts/${id}/unapprove`, { method: 'POST' }); setPost(p); return renderPost(id); }
    if (a === 'mark-posted') { state.awaitingConfirm = id; return askPosted(); }
    if (a === 'delete') {
      const m = modal(`<h2>Delete this set?</h2><p class="muted">This removes its photos and captions from the app</p><div class="row"><button class="btn-ghost" data-a="no">Keep</button><button class="btn-primary" data-a="yes" style="background:var(--bad)">Delete</button></div>`);
      m.onclick = async (ev) => {
        const x = ev.target.closest('[data-a]')?.dataset.a; if (!x) return;
        modal(null);
        if (x === 'yes') { await api(`/api/posts/${id}`, { method: 'DELETE' }); state.posts = state.posts.filter((p) => p.id !== id); updateBadge(); location.hash = '#/posts'; }
      };
    }
  }
}

// Shown while the server picks photos and writes captions.
function renderPreparing(post) {
  const s = service(post.serviceId);
  const usable = post.photos.filter((p) => !p.dropped && !p.duplicateOf);
  const failed = post.stage === 'failed';
  $app.innerHTML = `
    <a href="#/posts" class="back">${icon('left')}All posts</a>
    <h1 style="margin:8px 0">${esc(setTitle(post))}</h1>
    <p class="muted small">${setDetail(post) ? esc(setDetail(post)) + ' · ' : ''}by ${esc(post.tech)} · ${post.photos.length} photos uploaded</p>
    <div class="card" style="text-align:center">
      ${failed
        ? `<h2>This set didn’t finish</h2><p class="muted small">${esc(post.stageError || 'Something went wrong')}</p><button class="btn-primary" data-act="retry">Try again</button>`
        : `<div class="spinner"></div><h2>${post.stage === 'captions' ? 'Writing captions' : 'Picking the best shots'}</h2><p class="muted small" style="margin:0">This page updates on its own</p>`}
    </div>
    <div class="grid">${usable.map((p) => `<div class="tile"><img src="${p.url}" alt="" data-view="${p.url}"></div>`).join('')}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="link" data-act="delete" style="color:var(--bad)">Delete set</button></div>`;
  $app.onclick = async (e) => {
    const v = e.target.closest('[data-view]');
    if (v) return viewPhoto(v.dataset.view);
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'retry') {
      const { post: p } = await api(`/api/posts/${post.id}/retry`, { method: 'POST' });
      p.stage = p.stage === 'failed' ? 'picking' : p.stage; setPost(p); renderPost(post.id);
    } else if (a === 'delete') {
      const m = modal(`<h2>Delete this set?</h2><p class="muted">This removes its photos from the app</p><div class="row"><button class="btn-ghost" data-a="no">Keep</button><button class="btn-primary" data-a="yes" style="background:var(--bad)">Delete</button></div>`);
      m.onclick = async (ev) => {
        const x = ev.target.closest('[data-a]')?.dataset.a; if (!x) return;
        modal(null);
        if (x === 'yes') { await api(`/api/posts/${post.id}`, { method: 'DELETE' }); state.posts = state.posts.filter((p) => p.id !== post.id); updateBadge(); location.hash = '#/posts'; }
      };
    }
  };
}

function viewPhoto(url) {
  const m = document.getElementById('modal');
  m.innerHTML = `<img class="viewer" src="${url}" alt=""><button class="viewer-close" aria-label="Close">${icon('x')}</button>`;
  m.classList.add('dark'); m.hidden = false;
  m.onclick = () => { m.hidden = true; m.classList.remove('dark'); m.innerHTML = ''; };
}

function nextSlotLabel() {
  // Preview only; the server assigns the real slot on approve.
  const taken = new Set(state.posts.filter((p) => p.scheduledFor).map((p) => new Date(p.scheduledFor).toDateString()));
  const now = new Date();
  for (let i = 0; i < 60; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i);
    const dow = d.getDay(); d.setHours(dow === 0 || dow >= 5 ? 19 : 12, 0, 0, 0);
    if (d > now && !taken.has(d.toDateString())) return fmtSlot(d.toISOString());
  }
  return 'the next open day';
}

// ---------- sign in (PIN) ----------
async function startApp() {
  state.config = await api('/api/config');
  state.posts = (await api('/api/posts')).posts;
  document.querySelector('[data-tab="posts"]').hidden = !isOwner();
  document.getElementById('who').textContent = state.user.name;
  document.getElementById('signout').hidden = false;
  document.querySelector('.tabs').hidden = false;
  document.querySelector('.top').classList.toggle('three', isOwner());
  document.querySelector('[data-tab="jobs"]').firstChild.textContent = isOwner() ? 'Bookings ' : 'Jobs ';
  document.getElementById('admin-btn').hidden = !isOwner();
  state.admin = null;
  state.jobs = null; knownJobs = null;
  loadJobs().catch(() => {});
  if (!isOwner()) state.upload.techId = state.user.id;
  updateBadge();
  setupHint();
  render();
}

let signInShown = false;
async function showSignIn() {
  if (signInShown) return;
  signInShown = true;
  state.user = null;
  document.querySelector('.tabs').hidden = true;
  document.getElementById('signout').hidden = true;
  document.getElementById('admin-btn').hidden = true;
  document.getElementById('who').textContent = 'Studio';
  const bar = document.querySelector('.bar'); if (bar) bar.remove();
  document.body.style.paddingBottom = '24px';
  const { staff } = await fetch('/api/staff', { headers: TUNNEL_HEADERS }).then((r) => r.json());
  let who = staff.find((s) => s.id === localStorage.getItem('lastStaff')) || null;
  let pin = '';
  let busy = false;
  let error = '';

  const draw = () => {
    if (!who) {
      $app.innerHTML = `
        <h1>Sign in</h1>
        <p class="muted">Tap your name, then enter your PIN</p>
        <div class="menu" id="staff">${staff.map((s) => `<button type="button" class="menu-row" data-who="${s.id}"><span class="name">${esc(s.name)}</span><span class="price">${s.role === 'owner' ? 'Owner' : 'Nail tech'}</span></button>`).join('')}</div>
        <p class="muted small" style="margin-top:16px"><a href="/" style="color:var(--gold-ink)">Go to the public site</a></p>`;
      return;
    }
    $app.innerHTML = `
      <button type="button" class="back link-plain" data-who-change>${icon('left')}Not ${esc(who.name)}?</button>
      <h1 style="margin-top:8px">Hi, ${esc(who.name)}</h1>
      <p class="muted">Enter your PIN</p>
      <div class="pin-dots" aria-live="polite">${Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('')}</div>
      <p class="pin-error" role="alert">${esc(error)}</p>
      <div class="pinpad">
        ${['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => `<button type="button" data-key="${k}">${k}</button>`).join('')}
        <button type="button" data-key="del" aria-label="Delete">${icon('back')}</button>
        <button type="button" data-key="0">0</button>
        <button type="button" data-key="ok" class="ok" ${pin.length < 4 || busy ? 'disabled' : ''}>${busy ? '…' : 'Go'}</button>
      </div>`;
  };

  async function submit() {
    if (pin.length < 4 || busy) return;
    busy = true; error = ''; draw();
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...TUNNEL_HEADERS }, body: JSON.stringify({ id: who.id, pin }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Sign-in failed');
      localStorage.setItem('lastStaff', who.id);
      state.user = json.user;
      signInShown = false;
      document.removeEventListener('keydown', onKey);
      $app.onclick = null;
      location.hash = isOwner() ? '#/posts' : '#/upload';
      await startApp();
    } catch (err) {
      error = err.message; pin = ''; busy = false; draw();
    }
  }
  function press(k) {
    if (busy) return;
    if (k === 'del') pin = pin.slice(0, -1);
    else if (k === 'ok') return submit();
    else if (pin.length < 6) pin += k;
    error = ''; draw();
  }
  function onKey(e) {
    if (!who) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
    else if (e.key === 'Enter') press('ok');
  }
  document.addEventListener('keydown', onKey);
  $app.onclick = (e) => {
    const w = e.target.closest('[data-who]');
    if (w) { who = staff.find((s) => s.id === w.dataset.who); pin = ''; error = ''; return draw(); }
    if (e.target.closest('[data-who-change]')) { who = null; pin = ''; error = ''; return draw(); }
    const k = e.target.closest('[data-key]');
    if (k) press(k.dataset.key);
  };
  draw();
}

async function signOut() {
  await fetch('/api/logout', { method: 'POST', headers: TUNNEL_HEADERS }).catch(() => {});
  state.user = null; state.config = null; state.posts = []; state.filesCache = {}; state.jobs = null;
  Object.assign(state.upload, { results: [], serviceId: null, option: null, gel: false, addons: {}, menuOpen: true });
  location.hash = '';
  showSignIn();
}
document.getElementById('signout').onclick = () => {
  const m = modal(`<h2>Sign out?</h2><p class="muted">Photos you haven’t sent yet will be cleared</p><div class="row"><button class="btn-ghost" data-a="no">Stay</button><button class="btn-primary" data-a="yes">Sign out</button></div>`);
  m.onclick = (e) => {
    const x = e.target.closest('[data-a]')?.dataset.a; if (!x) return;
    modal(null);
    if (x === 'yes') signOut();
  };
};

// ---------- on-demand jobs and bookings ----------
// Techs: go on call, see requests they can take, accept or decline, see their schedule.
// Tina: sees the bookings schedule by location, open requests and who is on call.
state.jobs = null;
state.view.loc = 'all';
const fmtMins = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`);
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayLabel = (iso) => {
  const d = new Date(iso), now = new Date();
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === tmr.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
};
const whenLabel = (j) => (j.start ? `${dayLabel(j.start)}, ${fmtTime(j.start)} to ${fmtTime(j.end)}` : 'Right now');
const locName = (id) => state.config.brand.locations.find((l) => l.id === id)?.name || '';
const mapsUrl = (w) => (w.lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${w.lat},${w.lng}` : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(w.address || '')}`);
function whereLabel(w, full) {
  if (w.type !== 'house') return w.name || 'At the studio';
  if (full && w.address) return `House call · ${w.address}`;
  return `House call · ${w.distanceMi != null ? `${w.distanceMi} mi away` : 'distance unknown'}`;
}
const switchHtml = (id, on, label) => `<button type="button" class="switch ${on ? 'on' : ''}" id="${id}" role="switch" aria-checked="${on}" aria-label="${esc(label)}"><i></i></button>`;
const choice = (key, val, opts, fmt) => `<div class="chips" data-key="${key}">${opts.map((o) => `<button type="button" class="chip ${o === val ? 'on' : ''}" data-v="${o}">${fmt(o)}</button>`).join('')}</div>`;

async function loadJobs() {
  state.jobs = await api('/api/jobs');
  updateJobsBadge();
  return state.jobs;
}
function updateJobsBadge() {
  const b = document.getElementById('jobs-badge');
  if (!b || !state.jobs) return;
  const n = isOwner()
    ? state.jobs.requests.filter((r) => r.status === 'searching' && (state.jobs.settings.assign === 'owner' ? r.accepted.length : true)).length
    : state.jobs.open.filter((j) => !j.accepted).length;
  b.textContent = n; b.hidden = !n;
}

function jobFacts(j, full) {
  return `<div class="facts">
    <div><span>When</span><b>${esc(whenLabel(j))}</b></div>
    <div><span>Takes</span><b>About ${fmtMins(j.minutes)}</b></div>
    <div><span>Where</span><b>${esc(whereLabel(j.where, full))}</b></div>
    ${j.client?.name ? `<div><span>Client</span><b>${esc(j.client.name)}${j.client.phone ? ` · <a href="tel:${esc(j.client.phone.replace(/[^0-9+]/g, ''))}">${esc(j.client.phone)}</a>` : ''}</b></div>` : ''}
    ${j.notes ? `<div><span>Notes</span><b>${esc(j.notes)}</b></div>` : ''}
  </div>`;
}

// One day-by-day list of bookings: the schedule.
function scheduleHtml(list, { who } = {}) {
  if (!list.length) return '<div class="card muted" style="text-align:center">No bookings yet</div>';
  const sorted = [...list].sort((a, b) => new Date(a.start) - new Date(b.start));
  const days = [];
  for (const j of sorted) {
    const key = new Date(j.start).toDateString();
    if (!days.length || days[days.length - 1].key !== key) days.push({ key, label: dayLabel(j.start), items: [] });
    days[days.length - 1].items.push(j);
  }
  return days.map((d) => `<div class="day"><div class="day-label">${esc(d.label)}</div><div class="card sched">${d.items.map((j) => `
    <div class="slot ${j.status === 'done' ? 'past' : ''}">
      <div class="t"><b>${fmtTime(j.start)}</b><span>${fmtTime(j.end)}</span></div>
      <div class="d"><div class="n">${esc(j.serviceName)}</div>
        <div class="muted small">${[who ? esc(j.techName || '') : '', esc(j.where.type === 'house' ? (j.where.address ? 'House call · ' + j.where.address : 'House call') : j.where.name || ''), esc(j.client?.name || '')].filter(Boolean).join(' · ')}</div>
        ${j.status === 'done' ? '<span class="status posted">Done</span>' : ''}</div>
    </div>`).join('')}</div></div>`).join('');
}

function techJobCard(j) {
  const head = `<div class="job-head"><div><div class="title">${esc(j.serviceName)}</div>${j.forYou ? '<span class="status needs_approval">Asked for you</span>' : ''}</div>
    <div class="pay"><b>${esc(fmtMins(j.minutes))}</b><span>${j.start ? fmtTime(j.start) : 'now'}</span></div></div>`;
  if (j.status === 'confirmed') {
    return `<div class="card job mine">${head}${jobFacts(j, true)}
      <div class="row" style="margin-top:12px">${j.where.type === 'house' ? `<a class="btn btn-line" href="${mapsUrl(j.where)}" target="_blank" rel="noopener">Directions</a>` : ''}<button class="btn-primary" data-job="${j.id}" data-act="done">Mark done</button></div></div>`;
  }
  return `<div class="card job">${head}${jobFacts(j, false)}
    ${j.accepted
      ? `<div class="waiting"><span class="status needs_approval">You said yes. Tina is picking who takes it</span><button class="link" data-job="${j.id}" data-act="decline">Withdraw</button></div>`
      : `<div class="row" style="margin-top:12px"><button class="btn-ghost" data-job="${j.id}" data-act="decline">Decline</button><button class="btn-primary" data-job="${j.id}" data-act="accept">Accept</button></div>`}
    ${j.where.type === 'house' ? '<p class="muted small" style="margin-top:8px">You’ll see the address and phone number once the job is yours</p>' : ''}
  </div>`;
}

// ----- on-call time helpers -----
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK = [1, 2, 3, 4, 5, 6, 0]; // show Monday first
function fmtHM(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
}
const daysLabel = (days) => WEEK.filter((d) => days.includes(d)).map((d) => DAY_NAMES[d]).join(', ');
const windowLabel = (w) => `${daysLabel(w.days)}, ${fmtHM(w.start)} to ${fmtHM(w.end)}`;
function availabilityLine(oc) {
  if (oc.on) return oc.until ? `On call until ${fmtTime(oc.until)}` : 'On call until turned off';
  if (oc.by === 'hours') return `On call until ${fmtHM(oc.windowEnd)}, regular hours`;
  return 'Off call';
}
state.view.ocPick = false;
state.view.addHours = null;

function renderTechJobs() {
  const { oncall: oc, open, mine } = state.jobs;
  const booked = mine.filter((j) => j.status === 'confirmed');
  const me = state.config.brand.techs.find((t) => t.id === state.user.id);
  $app.innerHTML = `
    <h1>Jobs</h1>
    <div class="card oncall ${oc.activeNow ? 'is-on' : ''}">
      <div class="oc-row"><div><div class="oc-t">${esc(availabilityLine(oc))}</div>
        <div class="muted small">${oc.activeNow ? `Requests for ${esc((me?.locationIds || []).map(locName).filter(Boolean).join(' and ') || 'your studio')} come here` : 'Turn on to get job requests from clients'}</div></div>
        ${switchHtml('oc-on', oc.on, 'On call')}</div>
      ${oc.on && !state.view.ocPick ? '<button type="button" class="link" id="oc-change" style="margin-top:8px;padding-left:0">Change how long</button>' : ''}
      ${state.view.ocPick ? `
        <div class="oc-set">
          <div class="lbl">How long?</div>
          <div class="chips" id="oc-for">
            <button type="button" class="chip" data-for="60">1 hour</button>
            <button type="button" class="chip" data-for="120">2 hours</button>
            <button type="button" class="chip" data-for="240">4 hours</button>
            <button type="button" class="chip" data-for="0">Until I turn it off</button>
          </div>
          <div class="lbl">Or until a time</div>
          <div class="until-row"><input class="field" type="time" id="oc-until" step="900" aria-label="On call until"><button type="button" class="btn-primary" id="oc-until-go">Go on call</button></div>
          <button type="button" class="link" id="oc-cancel" style="margin-top:8px;padding-left:0">Cancel</button>
        </div>` : ''}
      <div class="oc-set">
        <div class="lbl">Take jobs for</div>
        <div class="seg" data-key="takes">${[['now', 'Right now'], ['later', 'Booked ahead'], ['both', 'Both']].map(([v, l]) => `<button type="button" data-v="${v}" class="${oc.takes === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="oc-row" style="margin-top:16px"><div><div class="lbl" style="margin:0">House calls</div><div class="muted small">Go to the client’s home, hotel or office</div></div>${switchHtml('oc-house', oc.houseCalls, 'House calls')}</div>
        ${oc.houseCalls ? `<div class="lbl">How far you’ll go</div>${choice('radiusMi', oc.radiusMi, [3, 5, 10, 15, 25], (v) => `${v} mi`)}` : ''}
      </div>
      <div class="oc-set">
        <div class="lbl">Regular hours</div>
        <p class="muted small" style="margin-bottom:8px">You’re on call at these times every week, even with the switch off. Clients can book you ahead for them</p>
        ${(oc.hours || []).map((w, i) => `<div class="hours-row"><span>${esc(windowLabel(w))}</span><button type="button" class="icon-btn" data-del-hours="${i}" aria-label="Remove ${esc(windowLabel(w))}">${icon('x')}</button></div>`).join('')}
        ${state.view.addHours ? `
          <div class="add-hours">
            <div class="chips" id="ah-days">${WEEK.map((d) => `<button type="button" class="chip ${state.view.addHours.days.includes(d) ? 'on' : ''}" data-day="${d}">${DAY_NAMES[d]}</button>`).join('')}</div>
            <div class="until-row"><label class="small">From<input class="field" type="time" id="ah-start" step="900" value="${state.view.addHours.start}"></label><label class="small">To<input class="field" type="time" id="ah-end" step="900" value="${state.view.addHours.end}"></label></div>
            <p class="muted small">An end time earlier than the start runs past midnight</p>
            <div class="row"><button type="button" class="btn-ghost" id="ah-cancel">Cancel</button><button type="button" class="btn-primary" id="ah-save">Add hours</button></div>
          </div>` : '<button type="button" class="btn-line" id="ah-open" style="width:100%">Add regular hours</button>'}
      </div>
    </div>
    <div class="section-label">Requests${open.length ? ` (${open.length})` : ''}</div>
    ${open.length ? open.map(techJobCard).join('') : `<div class="card muted" style="text-align:center">${oc.activeNow || oc.hours?.length ? 'No requests right now. New ones show up here, and your phone buzzes' : 'You’re off call, so no requests come to you'}</div>`}
    ${booked.length ? `<div class="section-label">Up next</div>${techJobCard(booked.sort((a, b) => new Date(a.start) - new Date(b.start))[0])}` : ''}
    ${mine.length > 1 || !booked.length ? `<div class="section-label">Your schedule</div>
    ${scheduleHtml(mine.filter((j) => j !== booked[0]))}` : ''}`;

  const saveOc = async (patch) => {
    try { await api('/api/oncall', { method: 'PUT', body: patch }); await loadJobs(); renderTechJobs(); }
    catch (err) { toast(err.message); }
  };
  $app.onclick = async (e) => {
    // Turning on asks how long; turning off is one tap.
    if (e.target.closest('#oc-on')) { if (oc.on) { state.view.ocPick = false; return saveOc({ on: false }); } state.view.ocPick = true; return renderTechJobs(); }
    if (e.target.closest('#oc-change')) { state.view.ocPick = true; return renderTechJobs(); }
    if (e.target.closest('#oc-cancel')) { state.view.ocPick = false; return renderTechJobs(); }
    const f = e.target.closest('[data-for]');
    if (f) { state.view.ocPick = false; return saveOc(Number(f.dataset.for) ? { on: true, forMinutes: Number(f.dataset.for) } : { on: true }); }
    if (e.target.closest('#oc-until-go')) {
      const v = document.getElementById('oc-until').value;
      if (!v) return toast('Pick a time first');
      const [h, m] = v.split(':').map(Number);
      const until = new Date(); until.setHours(h, m, 0, 0);
      if (until <= new Date()) until.setDate(until.getDate() + 1); // a time earlier than now means tomorrow
      state.view.ocPick = false;
      return saveOc({ on: true, until: until.toISOString() });
    }
    if (e.target.closest('#ah-open')) { state.view.addHours = { days: [], start: '20:00', end: '02:00' }; return renderTechJobs(); }
    if (e.target.closest('#ah-cancel')) { state.view.addHours = null; return renderTechJobs(); }
    const day = e.target.closest('[data-day]');
    if (day) {
      const ah = state.view.addHours, d = Number(day.dataset.day);
      ah.start = document.getElementById('ah-start').value || ah.start; ah.end = document.getElementById('ah-end').value || ah.end;
      ah.days = ah.days.includes(d) ? ah.days.filter((x) => x !== d) : [...ah.days, d];
      return renderTechJobs();
    }
    if (e.target.closest('#ah-save')) {
      const ah = state.view.addHours;
      const w = { days: ah.days, start: document.getElementById('ah-start').value, end: document.getElementById('ah-end').value };
      if (!w.days.length) return toast('Pick at least one day');
      try { await api('/api/oncall', { method: 'PUT', body: { hours: [...(oc.hours || []), w] } }); state.view.addHours = null; await loadJobs(); renderTechJobs(); toast('Regular hours added'); }
      catch (err) { toast(err.message); }
      return;
    }
    const del = e.target.closest('[data-del-hours]');
    if (del) return saveOc({ hours: oc.hours.filter((_, i) => i !== Number(del.dataset.delHours)) });
    if (e.target.closest('#oc-house')) return saveOc({ houseCalls: !oc.houseCalls });
    const pick = e.target.closest('[data-key] [data-v]');
    if (pick) { const key = pick.closest('[data-key]').dataset.key; const v = pick.dataset.v; return saveOc({ [key]: key === 'takes' ? v : Number(v) }); }
    const b = e.target.closest('[data-job]');
    if (b) {
      b.disabled = true;
      try {
        state.jobs = await api(`/api/jobs/${b.dataset.job}/${b.dataset.act}`, { method: 'POST', body: {} });
        updateJobsBadge();
        toast({ accept: state.jobs.mine.some((j) => j.id === b.dataset.job && j.status === 'confirmed') ? 'It’s yours. The client’s details are below' : 'Sent. Tina will confirm who takes it', decline: 'Declined', done: 'Marked done' }[b.dataset.act]);
      } catch (err) { toast(err.message); await loadJobs(); }
      renderTechJobs();
    }
  };
}

function ownerJobCard(r) {
  const s = state.jobs.settings;
  const statusLine = {
    searching: r.accepted.length && s.assign === 'owner' ? `<span class="status needs_approval">${r.accepted.length} said yes. Pick one</span>`
      : r.waiting.length ? `<span class="status ready">Waiting on ${esc(r.waiting.join(', '))}</span>` : `<span class="status overdue">${r.when === 'now' ? 'No one on call can take it' : 'No one is free then'}</span>`,
    confirmed: `<span class="status ready">Booked with ${esc(r.techName)}</span>`,
    done: `<span class="status posted">Done by ${esc(r.techName)}</span>`,
    cancelled: `<span class="status posted">Cancelled by ${r.cancelledBy === 'studio' ? 'you' : 'the client'}</span>`,
    expired: '<span class="status posted">No one took it in time</span>',
  }[r.status] || '';
  if (r.status !== 'searching' && r.status !== 'confirmed') {
    return `<div class="card list-item"><div class="meta"><div class="title">${esc(r.serviceName)}</div><div class="muted small" style="margin-bottom:4px">${esc(r.client.name)} · ${esc(whereLabel(r.where))}</div>${statusLine}</div></div>`;
  }
  return `<div class="card job">
    <div class="job-head"><div><div class="title">${esc(r.serviceName)}</div>${statusLine}</div><div class="pay"><b>${esc(fmtMins(r.minutes))}</b><span>${r.start ? fmtTime(r.start) : 'now'}</span></div></div>
    ${jobFacts(r, true)}
    ${r.preferTechName ? `<p class="muted small">Asked for ${esc(r.preferTechName)}</p>` : ''}
    ${r.declined.length ? `<p class="muted small">Declined: ${esc(r.declined.join(', '))}</p>` : ''}
    ${r.status === 'searching' && r.accepted.length && s.assign === 'owner' ? `<div class="offers">${r.accepted.map((a) => `<div class="offer"><div><b>${esc(a.name)}</b> said yes</div><button class="btn-primary" data-job="${r.id}" data-act="assign" data-tech="${a.techId}">Give to ${esc(a.name)}</button></div>`).join('')}</div>` : ''}
    <div class="row" style="margin-top:12px">
      <button class="btn-ghost" data-job="${r.id}" data-act="cancel">Cancel</button>
      ${r.status === 'confirmed' ? `<button class="btn-line" data-job="${r.id}" data-act="done">Mark done</button>` : ''}
    </div>
  </div>`;
}

function renderOwnerJobs() {
  const { settings: s, team, requests } = state.jobs;
  const locs = state.config.brand.locations.filter((l) => l.status === 'open');
  const at = state.view.loc;
  const inLoc = (r) => at === 'all' || (at === 'house' ? r.where.type === 'house' : r.where.locationId === at);
  const open = requests.filter((r) => r.status === 'searching' && inLoc(r));
  const sched = requests.filter((r) => (r.status === 'confirmed' || r.status === 'done') && r.start && inLoc(r) && new Date(r.end) > Date.now() - 12 * 3600_000);
  const past = requests.filter((r) => ['cancelled', 'expired'].includes(r.status) && inLoc(r)).slice(0, 8);
  const teamHere = team.filter((t) => (at === 'all' ? true : at === 'house' ? t.houseCalls : t.locationIds.includes(at)));
  $app.innerHTML = `
    <h1>Bookings</h1>
    <div class="chips loc-filter" data-key="loc" style="margin-bottom:16px">
      ${[['all', 'All locations'], ...locs.map((l) => [l.id, l.name]), ['house', 'House calls']].map(([v, l]) => `<button type="button" class="chip ${at === v ? 'on' : ''}" data-v="${v}">${esc(l)}</button>`).join('')}
    </div>
    ${open.length ? `<div class="section-label" style="margin-top:0">Waiting for an artist (${open.length})</div>${open.map(ownerJobCard).join('')}` : ''}
    <div class="section-label" ${open.length ? '' : 'style="margin-top:0"'}>Schedule</div>
    ${scheduleHtml(sched, { who: true })}
    ${sched.filter((r) => r.status === 'confirmed').length ? `<details class="more"><summary>Manage booked jobs</summary>${sched.filter((r) => r.status === 'confirmed').map(ownerJobCard).join('')}</details>` : ''}
    <div class="section-label">On call now (${teamHere.filter((t) => t.activeNow).length} of ${teamHere.length})</div>
    <div class="card team">${teamHere.length ? teamHere.map((t) => `<div class="team-row"><div><b>${esc(t.name)}</b><div class="muted small">${esc(t.locationIds.map(locName).filter(Boolean).join(', '))}</div></div><span class="status ${t.activeNow ? 'ready' : 'posted'}">${esc(availabilityLine(t).replace('On call until turned off', 'On call').replace('Off call', 'Off'))}</span>${t.hours?.length || (t.activeNow && t.houseCalls) ? `<div class="muted small team-sub">${[t.hours?.length ? `Regular hours: ${t.hours.map(windowLabel).join('; ')}` : '', t.activeNow && t.houseCalls ? `House calls up to ${t.radiusMi} mi` : ''].filter(Boolean).map(esc).join('<br>')}</div>` : ''}</div>`).join('') : '<p class="muted">No one works here yet. Add them in Admin</p>'}</div>
    <div class="section-label">Who gets a job</div>
    <div class="card">
      <div class="seg" data-key="assign"><button type="button" data-v="first" class="${s.assign === 'first' ? 'on' : ''}">First to accept</button><button type="button" data-v="owner" class="${s.assign === 'owner' ? 'on' : ''}">I choose</button></div>
      <p class="muted small" style="margin-top:8px">${s.assign === 'first' ? 'The first artist who says yes is booked right away' : 'Artists say yes, then you pick one. The client waits until you do'}</p>
    </div>
    ${past.length ? `<div class="section-label">Didn’t happen</div>${past.map(ownerJobCard).join('')}` : ''}
    <p class="small" style="text-align:center;margin-top:16px"><a href="/request" target="_blank" style="color:var(--gold-ink)">Open the request page clients use</a></p>`;

  const armed = new Set();
  $app.onclick = async (e) => {
    const pick = e.target.closest('[data-key] [data-v]');
    if (pick) {
      const key = pick.closest('[data-key]').dataset.key;
      if (key === 'loc') { state.view.loc = pick.dataset.v; return renderOwnerJobs(); }
      try { await api('/api/jobs-settings', { method: 'PUT', body: { assign: pick.dataset.v } }); await loadJobs(); renderOwnerJobs(); }
      catch (err) { toast(err.message); }
      return;
    }
    const b = e.target.closest('[data-job]');
    if (!b) return;
    // Cancelling needs a second tap, so a stray tap can't drop a client.
    if (b.dataset.act === 'cancel' && !armed.has(b.dataset.job)) { armed.add(b.dataset.job); b.textContent = 'Tap again to cancel'; return; }
    b.disabled = true;
    try {
      state.jobs = await api(`/api/jobs/${b.dataset.job}/${b.dataset.act}`, { method: 'POST', body: { techId: b.dataset.tech } });
      updateJobsBadge();
      toast({ assign: 'Booked. The client can see who’s coming', cancel: 'Cancelled', done: 'Marked done' }[b.dataset.act]);
    } catch (err) { toast(err.message); await loadJobs(); }
    renderOwnerJobs();
  };
}

async function renderJobs() {
  if (!state.jobs) {
    $app.innerHTML = '<div class="card muted" style="text-align:center"><div class="spinner"></div>Loading</div>';
    try { await loadJobs(); } catch (err) { $app.innerHTML = `<div class="card">${esc(err.message)}</div>`; return; }
    if (!location.hash.startsWith('#/jobs')) return;
  }
  (isOwner() ? renderOwnerJobs : renderTechJobs)();
}

// Keep jobs fresh, and buzz when a new request arrives.
let knownJobs = null;
async function pollJobs() {
  if (!state.user || document.visibilityState !== 'visible' || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  try {
    const before = JSON.stringify(state.jobs);
    await loadJobs();
    const ids = isOwner() ? state.jobs.requests.filter((r) => r.status === 'searching').map((r) => r.id) : state.jobs.open.map((j) => j.id);
    if (knownJobs && ids.some((id) => !knownJobs.has(id))) {
      toast(isOwner() ? 'New request from a client' : 'New job request');
      navigator.vibrate?.([120, 60, 120]);
    }
    knownJobs = new Set(ids);
    if (location.hash.startsWith('#/jobs') && JSON.stringify(state.jobs) !== before && !$app.querySelector('button:disabled, details[open]') && !state.view.ocPick && !state.view.addHours) renderJobs();
  } catch {}
}
setInterval(pollJobs, 4000);

// ---------- admin: team and locations (owner only) ----------
state.admin = null;
state.view.adminTab = 'activity';
state.view.actDays = 7;
state.activity = null;
const ago = (iso) => {
  if (!iso) return 'No activity yet';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 2) return 'Active just now';
  if (m < 60) return `Active ${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `Active ${h} hr ago`;
  const d = Math.round(h / 24); return `Active ${d} day${d === 1 ? '' : 's'} ago`;
};
const fmtHrs = (h) => (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10).toString();
const stat = (n, label) => `<div><b>${n}</b><span>${label}</span></div>`;

// Activity: what each artist and each studio has been doing. Counts only, no money.
async function renderActivity(head) {
  const days = state.view.actDays;
  if (!state.activity || state.activity.days !== days) {
    $app.innerHTML = `${head}<div class="card muted" style="text-align:center"><div class="spinner"></div>Loading</div>`;
    try { state.activity = await api(`/api/admin/activity?days=${days}`); } catch (err) { $app.innerHTML = `${head}<div class="card">${esc(err.message)}</div>`; return; }
    if (state.view.adminTab !== 'activity' || !location.hash.startsWith('#/admin')) return;
  }
  const A = state.activity, T = A.total;
  const nameOf = (id) => A.techs.find((t) => t.id === id)?.name || id;
  const range = { 7: 'in the last 7 days', 30: 'in the last 30 days', 0: 'so far' }[days];
  const techs = A.techs.filter((t) => t.active);
  const locs = [...A.locations.filter((l) => l.status === 'open'), ...(A.houseCalls.jobsDone || A.houseCalls.upcoming ? [A.houseCalls] : []), ...A.locations.filter((l) => l.status !== 'open')];
  $app.innerHTML = `${head}
    <div class="seg mini" id="act-days" style="margin-bottom:12px">${[[7, 'This week'], [30, '30 days'], [0, 'All time']].map(([d, l]) => `<button data-d="${d}" class="${days === d ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="card"><div class="stats act-stats">
      ${stat(T.uploads, 'sets uploaded')}${stat(T.approved, 'approved')}${stat(T.jobsDone, 'jobs done')}
      ${stat(T.upcoming, 'upcoming jobs')}${stat(`${T.onCallNow}/${T.artists}`, 'on call now')}${stat(T.toReview, 'to review')}
    </div><p class="muted small" style="margin:12px 0 0;text-align:center">Uploads, approvals and finished jobs ${range}. Upcoming counts every booked job still ahead</p></div>
    ${T.toReview ? `<a class="card list-item" href="#/posts"><div class="meta"><div class="title">${T.toReview} set${T.toReview === 1 ? '' : 's'} waiting for your review</div><div class="muted small">Approve them to show them on the site</div></div><span class="chev">${icon('right')}</span></a>` : ''}

    <div class="section-label">By artist</div>
    ${techs.map((t) => `<a class="card act-row" href="#/admin/tech/${t.id}">
      <div class="act-top"><div><div class="title">${esc(t.name)}${t.sample ? ' <span class="muted small">(sample)</span>' : ''}</div>
        <div class="muted small">${t.onCallNow ? `<span style="color:var(--ok)">${esc(availabilityLine(t.oncall))}</span>` : esc(ago(t.lastActive))}</div></div><span class="chev">${icon('right')}</span></div>
      <div class="stats act-mini">${stat(t.uploads, 'sets')}${stat(t.approved, 'approved')}${stat(t.jobsDone, 'jobs done')}${stat(fmtHrs(t.hoursOnCall), 'hrs on call')}</div>
      <div class="muted small act-foot">${[t.upcoming ? `${t.upcoming} upcoming` : '', t.saidYes ? `said yes to ${t.saidYes}` : '', t.saidNo ? `passed on ${t.saidNo}` : '', t.oncall.hours?.length ? `regular hours ${t.oncall.hours.map(windowLabel).join('; ')}` : ''].filter(Boolean).map(esc).join(' · ') || 'No requests taken yet'}</div>
    </a>`).join('') || '<div class="card muted">No artists yet</div>'}
    <a class="btn btn-line" href="#/admin/tech/new" style="width:100%">Add an artist</a>

    <div class="section-label">By location</div>
    ${locs.map((l) => `<div class="card act-loc">
      <div class="act-top"><div><div class="title">${esc(l.name)}</div>
        <div class="muted small">${l.id === 'house' ? 'Jobs at clients’ homes, hotels and offices' : l.status === 'open' ? `${l.artists.length} artist${l.artists.length === 1 ? '' : 's'}${l.waiting ? ` · <span style="color:var(--bad)">${l.waiting} waiting for an artist</span>` : ''}` : 'Coming soon'}</div></div>
        ${l.id === 'house' ? '' : `<a class="link-plain small" href="#/admin/location/${l.id}">Edit</a>`}</div>
      ${l.status === 'coming-soon' ? '' : `<div class="stats act-mini">${l.id === 'house' ? '' : stat(l.uploads, 'sets')}${l.id === 'house' ? '' : stat(l.approved, 'approved')}${stat(l.jobsDone, 'jobs done')}${stat(l.upcoming, 'upcoming')}</div>`}
      ${l.id === 'house' ? '' : `<div class="chips act-team">${l.artists.map((id) => { const t = A.techs.find((x) => x.id === id); return `<a class="chip" href="#/admin/tech/${id}">${t?.onCallNow ? '<i class="dot-on"></i>' : ''}${esc(nameOf(id))}</a>`; }).join('')}<button type="button" class="chip add" data-add-here="${l.id}">${icon('plus')}Add an artist here</button></div>`}
    </div>`).join('')}
    <p class="muted small" style="margin-top:8px">Hours on call count time with the On call switch on. Regular hours aren’t counted</p>`;
  document.getElementById('act-days').onclick = (e) => { const d = e.target.closest('[data-d]')?.dataset.d; if (d != null) { state.view.actDays = Number(d); renderAdmin(); } };
}
const PIN_NOTE = { demo: 'Demo PIN', admin: 'PIN set', server: 'PIN set on the server', none: 'No PIN yet' };

async function renderAdmin(sub, id) {
  if (!isOwner()) { location.hash = '#/upload'; return; }
  if (!state.admin) {
    $app.innerHTML = '<div class="card muted" style="text-align:center"><div class="spinner"></div>Loading</div>';
    try { state.admin = await api('/api/admin'); } catch (err) { $app.innerHTML = `<div class="card">${esc(err.message)}</div>`; return; }
  }
  if (sub === 'tech') return renderTechForm(id);
  if (sub === 'location') return renderLocationForm(id);
  const tab = state.view.adminTab;
  const { techs, locations } = state.admin;
  const lname = (lid) => locations.find((l) => l.id === lid)?.name || '';
  const active = techs.filter((t) => t.active !== false), gone = techs.filter((t) => t.active === false);
  const head = `
    <h1>Admin</h1>
    <div class="seg" id="adm-seg" style="margin-bottom:16px">
      <button data-t="activity" class="${tab === 'activity' ? 'on' : ''}">Activity</button>
      <button data-t="team" class="${tab === 'team' ? 'on' : ''}">Team (${active.length})</button>
      <button data-t="locations" class="${tab === 'locations' ? 'on' : ''}">Locations (${locations.filter((l) => l.status !== 'hidden').length})</button>
    </div>`;
  const bindTabs = () => { document.getElementById('adm-seg').onclick = (e) => { const t = e.target.closest('[data-t]')?.dataset.t; if (t) { state.view.adminTab = t; if (t === 'activity') state.activity = null; renderAdmin(); } }; };
  $app.onclick = async (e) => {
    const here = e.target.closest('[data-add-here]');
    if (here) { state.view.newTechLocs = [here.dataset.addHere]; location.hash = '#/admin/tech/new'; return; }
    const r = e.target.closest('[data-restore]');
    if (!r) return;
    try { state.admin = await api(`/api/admin/techs/${r.dataset.restore}/restore`, { method: 'POST', body: {} }); await refreshConfig(); toast('Back on the team'); renderAdmin(); }
    catch (err) { toast(err.message); }
  };
  if (tab === 'activity') { await renderActivity(head); return bindTabs(); }
  $app.innerHTML = `${head}
    ${tab === 'team' ? `
      ${active.map((t) => `<a class="card list-item" href="#/admin/tech/${t.id}"><span class="mono-s">${esc(t.name[0])}</span><div class="meta"><div class="title">${esc(t.name)}${t.sample ? ' <span class="muted small">(sample)</span>' : ''}</div>
        <div class="muted small">${esc(t.locationIds.map(lname).filter(Boolean).join(', '))} · ${t.serviceIds.length} services</div>
        <div class="muted small">${PIN_NOTE[t.pin]}${t.oncall.activeNow ? ` · <span style="color:var(--ok)">${esc(availabilityLine(t.oncall))}</span>` : ''}</div></div><span class="chev">${icon('right')}</span></a>`).join('')}
      <a class="btn btn-primary" href="#/admin/tech/new" style="margin-top:4px">Add an artist</a>
      ${gone.length ? `<div class="section-label">No longer on the team</div>${gone.map((t) => `<div class="card list-item"><div class="meta"><div class="title">${esc(t.name)}</div><div class="muted small">Can’t sign in. Their past work stays in Posts</div></div><button class="btn-ghost" style="min-height:44px" data-restore="${t.id}">Bring back</button></div>`).join('')}` : ''}
      <p class="muted small" style="margin-top:16px">Tina’s own PIN is set on the server (PIN_HASH_TINA). See the README</p>`
    : `
      ${locations.map((l) => `<a class="card list-item" href="#/admin/location/${l.id}"><div class="meta"><div class="title">${esc(l.name)}</div>
        <div class="muted small">${esc(l.address || 'No address yet')}</div>
        <span class="status ${l.status === 'open' ? 'ready' : l.status === 'coming-soon' ? 'needs_approval' : 'posted'}">${{ open: 'Open', 'coming-soon': 'Coming soon', hidden: 'Hidden' }[l.status]} · ${techs.filter((t) => t.active !== false && t.locationIds.includes(l.id)).length} artists</span></div><span class="chev">${icon('right')}</span></a>`).join('')}
      <a class="btn btn-primary" href="#/admin/location/new" style="margin-top:4px">Add a location</a>`}`;
  bindTabs();
}
async function refreshConfig() { state.config = await api('/api/config'); state.jobs = null; }

function renderTechForm(id) {
  const isNew = id === 'new';
  const t = isNew ? { name: '', bio: '', instagram: '', specialties: [], serviceIds: [], locationIds: state.view.newTechLocs || [], pin: 'none' } : state.admin.techs.find((x) => x.id === id);
  state.view.newTechLocs = null;
  if (!t) { location.hash = '#/admin'; return; }
  const { services, serviceGroups } = state.config.brand;
  const locs = state.admin.locations.filter((l) => l.status !== 'hidden');
  const sel = { services: new Set(t.serviceIds), locs: new Set(t.locationIds) };
  $app.innerHTML = `
    <a class="back" href="#/admin">${icon('left')}Admin</a>
    <h1 style="margin-top:8px">${isNew ? 'Add an artist' : esc(t.name)}</h1>
    <form id="tf" class="form" novalidate>
      <label>Name<input class="field" name="name" value="${esc(t.name)}" autocomplete="off" required></label>
      <div class="lbl">Works at</div>
      <div class="chips" data-set="locs">${locs.map((l) => `<button type="button" class="chip ${sel.locs.has(l.id) ? 'on' : ''}" data-v="${l.id}">${esc(l.name)}</button>`).join('')}</div>
      <div class="lbl">Services they do</div>
      ${serviceGroups.map((g) => `<div class="menu-group">${esc(g)}</div><div class="chips" data-set="services">${services.filter((s) => s.group === g).map((s) => `<button type="button" class="chip ${sel.services.has(s.id) ? 'on' : ''}" data-v="${s.id}">${esc(s.name)}</button>`).join('')}</div>`).join('')}
      <button type="button" class="link" id="all-svc" style="margin-top:8px">Select all services</button>
      <label>Short bio, shown on their public page<textarea class="field" name="bio" rows="3">${esc(t.bio)}</textarea></label>
      <label>Specialties, separated by commas<input class="field" name="specialties" value="${esc(t.specialties.join(', '))}"></label>
      <label>Instagram<input class="field" name="instagram" value="${esc(t.instagram || '')}" placeholder="@handle" autocapitalize="off"></label>
      <label>${isNew ? 'PIN to sign in (4 to 6 digits)' : `New PIN <span class="muted">(leave blank to keep: ${PIN_NOTE[t.pin].toLowerCase()})</span>`}<input class="field" name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" ${t.pin === 'server' ? 'disabled placeholder="Set on the server"' : ''}></label>
      <p class="form-error" role="alert"></p>
      <button class="btn-primary" id="save">${isNew ? 'Add to the team' : 'Save'}</button>
      ${isNew ? '' : `<button type="button" class="btn-ghost" id="remove" style="width:100%;margin-top:8px">Remove from the team</button>
        <p class="muted small" style="margin-top:8px">Removing stops their sign-in and takes them off the public site. Their past sets stay, and you can bring them back later</p>`}
    </form>`;
  const f = document.getElementById('tf');
  f.onclick = async (e) => {
    const c = e.target.closest('[data-set] [data-v]');
    if (c) { const set = sel[c.closest('[data-set]').dataset.set]; set.has(c.dataset.v) ? set.delete(c.dataset.v) : set.add(c.dataset.v); c.classList.toggle('on'); return; }
    if (e.target.closest('#all-svc')) { services.forEach((s) => sel.services.add(s.id)); f.querySelectorAll('[data-set="services"] .chip').forEach((x) => x.classList.add('on')); return; }
    const rm = e.target.closest('#remove');
    if (rm) {
      if (!rm.dataset.armed) { rm.dataset.armed = '1'; rm.textContent = `Tap again to remove ${t.name}`; return; }
      try { state.admin = await api(`/api/admin/techs/${id}/remove`, { method: 'POST', body: {} }); await refreshConfig(); toast(`${t.name} is off the team`); location.hash = '#/admin'; }
      catch (err) { toast(err.message); }
    }
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const body = { name: fd.get('name'), bio: fd.get('bio'), specialties: fd.get('specialties'), instagram: fd.get('instagram'), serviceIds: [...sel.services], locationIds: [...sel.locs] };
    if (fd.get('pin')) body.pin = fd.get('pin');
    const btn = document.getElementById('save'); btn.disabled = true;
    try {
      state.admin = await api(isNew ? '/api/admin/techs' : `/api/admin/techs/${id}`, { method: isNew ? 'POST' : 'PATCH', body });
      await refreshConfig();
      toast(isNew ? `${body.name} can sign in now` : 'Saved'); location.hash = '#/admin';
    } catch (err) { f.querySelector('.form-error').textContent = err.message; btn.disabled = false; }
  };
}

function renderLocationForm(id) {
  const isNew = id === 'new';
  const l = isNew ? { name: '', status: 'open', address: '', hours: 'Open 24 hours', hoursDetail: '', phone: '', lat: null, lng: null } : state.admin.locations.find((x) => x.id === id);
  if (!l) { location.hash = '#/admin'; return; }
  let status = l.status;
  $app.innerHTML = `
    <a class="back" href="#/admin">${icon('left')}Admin</a>
    <h1 style="margin-top:8px">${isNew ? 'Add a location' : esc(l.name)}</h1>
    <form id="lf" class="form" novalidate>
      <label>Name<input class="field" name="name" value="${esc(l.name)}" placeholder="Historic Core, DTLA"></label>
      <div class="lbl">Status</div>
      <div class="seg" id="st">${[['open', 'Open'], ['coming-soon', 'Coming soon'], ['hidden', 'Hidden']].map(([v, t]) => `<button type="button" data-v="${v}" class="${status === v ? 'on' : ''}">${t}</button>`).join('')}</div>
      <label>Address<input class="field" name="address" value="${esc(l.address || '')}" autocomplete="off"></label>
      <label>Map point <span class="muted">(in Google Maps, long-press the spot and copy the numbers)</span><input class="field" name="point" value="${l.lat != null ? `${l.lat}, ${l.lng}` : ''}" placeholder="34.0464, -118.2538" inputmode="decimal"></label>
      <label>Hours<input class="field" name="hours" value="${esc(l.hours || '')}"></label>
      <label>Hours detail<input class="field" name="hoursDetail" value="${esc(l.hoursDetail || '')}" placeholder="Walk-ins 9am to 8pm, appointments any hour after that"></label>
      <label>Phone<input class="field" name="phone" type="tel" value="${esc(l.phone || '')}"></label>
      <p class="form-error" role="alert"></p>
      <button class="btn-primary" id="save">${isNew ? 'Add location' : 'Save'}</button>
      <p class="muted small" style="margin-top:8px">Open locations show on the website, the map and the request form. Coming soon shows a card without booking. Hidden takes it off the website</p>
    </form>`;
  const f = document.getElementById('lf');
  document.getElementById('st').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; status = b.dataset.v; f.querySelectorAll('#st button').forEach((x) => x.classList.toggle('on', x === b)); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const body = { ...Object.fromEntries(fd), status };
    const btn = document.getElementById('save'); btn.disabled = true;
    try {
      state.admin = await api(isNew ? '/api/admin/locations' : `/api/admin/locations/${id}`, { method: isNew ? 'POST' : 'PATCH', body });
      await refreshConfig(); state.view.adminTab = 'locations';
      toast('Saved'); location.hash = '#/admin';
    } catch (err) { f.querySelector('.form-error').textContent = err.message; btn.disabled = false; }
  };
}

// ---------- router ----------
function render() {
  const h = location.hash || '#/upload';
  const [, route, id] = h.split('/');
  if (route === 'admin' && !id) state.admin = null; // fresh list each visit
  const tab = route === 'jobs' ? 'jobs' : route === 'posts' || route === 'post' ? 'posts' : route === 'admin' ? 'admin' : 'upload';
  document.getElementById('admin-btn')?.classList.toggle('on', route === 'admin');
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  $app.onclick = null;
  if (route !== 'post') state.view.editing = false;
  window.scrollTo(0, 0);
  if (!state.user || !state.config) return;
  if (!isOwner() && (route === 'posts' || route === 'post')) { location.hash = '#/upload'; return; }
  if (route === 'jobs') renderJobs();
  else if (route === 'admin') renderAdmin(id, h.split('/')[3]);
  else if (route === 'posts') renderPosts();
  else if (route === 'post') renderPost(id);
  else if (route === 'sent') renderSent(id);
  else renderUpload();
  fitBar();
}
// Keep content clear of the fixed action bar, whatever its height.
function fitBar() {
  requestAnimationFrame(() => {
    const bar = document.querySelector('.bar');
    document.body.style.paddingBottom = `${(bar ? bar.offsetHeight : 0) + 24}px`;
  });
}
new MutationObserver(fitBar).observe($app, { childList: true });
let lastRoute = '';
window.addEventListener('hashchange', () => {
  const r = location.hash.split('/').slice(0, 3).join('/');
  if (r !== lastRoute) state.taps = 0;
  lastRoute = r;
  render();
});


// ---------- add to home screen hint ----------
function setupHint() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const mobile = /iphone|ipad|android/i.test(navigator.userAgent);
  if (!mobile && !standalone) {
    const el = document.getElementById('a2hs');
    const url = state.config.phoneUrl;
    el.querySelector('span').innerHTML = url
      ? `Made for phones. Open <b>${esc(url)}</b> on your phone, or scan the QR code in the terminal`
      : 'Made for phones. Run <b>npm run phone</b> for a link that opens on your phone';
    el.hidden = false;
    document.getElementById('a2hs-close').onclick = () => (el.hidden = true);
    return;
  }
  if (standalone || localStorage.getItem('a2hs-seen')) return;
  const el = document.getElementById('a2hs');
  if (/android/i.test(navigator.userAgent)) el.querySelector('span').innerHTML = 'Tap <b>⋮</b>, then <b>Add to Home screen</b> to open this like an app';
  el.hidden = false;
  document.getElementById('a2hs-close').onclick = () => { el.hidden = true; localStorage.setItem('a2hs-seen', '1'); };
}

// ---------- boot ----------
(async function boot() {
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    state.user = (await api('/api/me')).user;
  } catch { return; } // showSignIn() already ran
  await startApp();
  // Keep the owner view fresh when sets arrive from the team.
  // Refresh while Tina is looking: new sets arrive, and sets finish getting ready.
  const sig = (list) => JSON.stringify(list.map((p) => [p.id, p.status, p.stage]));
  let busy = false;
  const poll = async () => {
    const onPosts = location.hash.startsWith('#/posts');
    const openId = location.hash.startsWith('#/post/') ? location.hash.split('/')[2] : null;
    const open = openId && state.posts.find((p) => p.id === openId);
    if (busy || !isOwner() || document.visibilityState !== 'visible' || !(onPosts || open?.stage)) return;
    busy = true;
    try {
      const { posts } = await api('/api/posts');
      if (sig(posts) !== sig(state.posts)) {
        state.posts = posts; updateBadge();
        if (onPosts) renderPosts(); else if (open) renderPost(openId);
      }
    } catch {} finally { busy = false; }
  };
  setInterval(() => {
    const preparing = state.posts.some((p) => p.stage && p.stage !== 'failed');
    if (preparing || Date.now() % 9000 < 3000) poll();
  }, 3000);
})();
