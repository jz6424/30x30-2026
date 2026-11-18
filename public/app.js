import { analyzeFile, markDuplicates } from './quality.js';

const $app = document.getElementById('app');
const state = {
  config: null,
  posts: [],
  upload: { tech: localStorage.getItem('tech') || '', serviceId: null, option: null, gel: false, addons: {}, menuOpen: true, results: [], analyzing: 0, sending: false },
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
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
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
  if (!res.ok || !json) throw new Error(json?.error || `Server error ${res.status}. Try again`);
  return json;
}
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

    <div class="section-label">Your name</div>
    <input type="text" id="tech" value="${esc(u.tech)}" placeholder="e.g. Kim" autocomplete="name">

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
      <div class="note">${!u.serviceId ? 'Pick the service first' : !kept.length ? 'Add photos of the set' : `${kept.length} photo${kept.length > 1 ? 's' : ''} ready`}</div>
      <button class="btn-primary" id="go" ${!u.serviceId || !kept.length || u.analyzing || u.sending ? 'disabled' : ''}>Pick the best shots</button>
    </div></div>`;

  document.getElementById('tech').oninput = (e) => { u.tech = e.target.value; localStorage.setItem('tech', u.tech); };
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
        tech: u.tech, serviceId: u.serviceId, option: u.option, gel: u.gel,
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
      <a class="btn btn-ghost" href="#/post/${post.id}">Open Tina’s view</a>
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
    <p class="muted small" style="text-align:center">Photo picker: ${esc(state.config.visionProvider)}</p>`;

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

// ---------- router ----------
function render() {
  const h = location.hash || '#/upload';
  const [, route, id] = h.split('/');
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (route === 'upload' || route === 'sent' ? 'upload' : 'posts')));
  $app.onclick = null;
  if (route !== 'post') state.view.editing = false;
  window.scrollTo(0, 0);
  if (route === 'posts') renderPosts();
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
  state.config = await api('/api/config');
  state.posts = (await api('/api/posts')).posts;
  updateBadge();
  setupHint();
  render();
  // Keep the owner view fresh when sets arrive from the team.
  // Refresh while Tina is looking: new sets arrive, and sets finish getting ready.
  const sig = (list) => JSON.stringify(list.map((p) => [p.id, p.status, p.stage]));
  let busy = false;
  const poll = async () => {
    const onPosts = location.hash.startsWith('#/posts');
    const openId = location.hash.startsWith('#/post/') ? location.hash.split('/')[2] : null;
    const open = openId && state.posts.find((p) => p.id === openId);
    if (busy || document.visibilityState !== 'visible' || !(onPosts || open?.stage)) return;
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
