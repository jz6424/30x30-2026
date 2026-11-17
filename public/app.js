import { analyzeFile, markDuplicates } from './quality.js';

const $app = document.getElementById('app');
const state = {
  config: null,
  posts: [],
  upload: { tech: localStorage.getItem('tech') || '', serviceId: null, results: [], analyzing: 0, sending: false },
  view: { channel: 'ig', editing: false, postsTab: 'needs_approval' },
  filesCache: {},        // postId -> File[] (prefetched so Share runs inside one tap)
  awaitingConfirm: null, // postId shared, ask "Did you post it?" on return
  taps: 0,
};

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Something went wrong');
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
const service = (id) => state.config?.brand.services.find((s) => s.id === id);
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
    const blob = await (await fetch(p.url)).blob();
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
    toast('Caption copied. This browser can’t attach photos, so use Save photos, then paste the caption.', 5000);
    return;
  }
  navigator.share({ files }).then(() => {
    state.awaitingConfirm = post.id;
    // Some browsers resolve after you come back; ask now if we're visible.
    if (document.visibilityState === 'visible') setTimeout(askPosted, 400);
  }).catch((err) => {
    if (err.name !== 'AbortError') toast('Couldn’t open the share sheet. Try Save photos.');
  });
  toast(channel === 'ig' ? 'Caption copied. Paste it in Instagram.' : 'Caption copied. Paste it in Facebook.', 4500);
  state.awaitingConfirm = post.id;
}
function askPosted() {
  const id = state.awaitingConfirm;
  if (!id || !document.getElementById('modal').hidden) return;
  state.awaitingConfirm = null;
  const m = modal(`<h2>Did you post it?</h2><p class="muted">We’ll move it to Posted.</p>
    <div class="row"><button class="btn-ghost" data-a="no">Not yet</button><button class="btn-gold" data-a="yes">Yes, posted</button></div>`);
  m.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    modal(null);
    if (a === 'yes') {
      const { post } = await api(`/api/posts/${id}/posted`, { method: 'POST', body: { taps: flushTaps() } });
      setPost(post); toast('Marked as posted 🎉'); render();
    }
  };
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.awaitingConfirm) setTimeout(askPosted, 300);
});
async function savePhotos(post) {
  const files = state.filesCache[post.id]?.files || (await prefetchFiles(post));
  for (const [i, f] of files.entries()) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    if (i < files.length - 1) await new Promise((r) => setTimeout(r, 350));
  }
  toast(`Saved ${files.length} photo${files.length > 1 ? 's' : ''}.`);
}

// Metrics: taps per post (counted while a post is open).
document.addEventListener('click', (e) => { if (location.hash.startsWith('#/post/') && e.target.closest('button')) state.taps++; }, true);
function flushTaps() { const t = state.taps; state.taps = 0; return t; }

// ---------- Upload (nail tech) ----------
function renderUpload() {
  const u = state.upload;
  const services = state.config.brand.services;
  const kept = u.results.filter((r) => !r.dropped && !r.duplicateOf);
  const tiles = u.results.map((r) => {
    let tag = `<span class="tag ok">✓ ${esc(r.pixelReason)}</span>`, cls = '';
    if (r.dropped) { tag = `<span class="tag bad">${esc(r.dropped)}</span>`; cls = 'out'; }
    else if (r.duplicateOf) { tag = `<span class="tag dup">Near copy, skipped</span>`; cls = 'out'; }
    return `<div class="tile ${cls}"><img src="${r.thumbUrl}" alt=""></div>`.replace('</div>', `${tag}</div>`);
  }).join('');
  $app.innerHTML = `
    <h1>New set</h1>
    <p class="muted">Add the photos from one finished set. We’ll pick the best shots and write the caption. Tina approves before anything goes out.</p>

    <div class="section-label">Your name</div>
    <input type="text" id="tech" value="${esc(u.tech)}" placeholder="e.g. Kim" autocomplete="name">

    <div class="section-label">Which service?</div>
    <div class="chips" id="services">
      ${services.map((s) => `<button class="chip ${u.serviceId === s.id ? 'on' : ''}" data-id="${s.id}">${esc(s.name)}<small>${esc(s.gelPrice ? s.price + '/' + s.gelPrice : s.price)}</small></button>`).join('')}
    </div>

    <div class="section-label">Photos</div>
    <label class="dropzone" for="file">
      <div><div class="big">＋ Add photos</div><div class="muted small">5 to 20 photos of the same set</div></div>
    </label>
    <input id="file" type="file" accept="image/*" multiple hidden>
    ${u.analyzing ? `<p class="muted small" style="margin-top:10px">Checking ${u.analyzing} photo${u.analyzing > 1 ? 's' : ''} for blur, glare and lighting…</p>` : ''}
    ${u.results.length ? `<p class="small" style="margin:12px 0 8px"><b>${kept.length}</b> good to use · ${u.results.length - kept.length} skipped</p><div class="grid">${tiles}</div>
      <button class="link" id="clear" style="margin-top:8px">Start over</button>` : ''}

    <div class="bar"><div class="inner">
      <div class="note">${!u.serviceId ? 'Pick the service' : !kept.length ? 'Add some photos' : 'Ready when you are'}</div>
      <button class="btn-primary" id="go" ${!u.serviceId || !kept.length || u.analyzing || u.sending ? 'disabled' : ''}>Pick the best shots</button>
    </div></div>`;

  document.getElementById('tech').oninput = (e) => { u.tech = e.target.value; localStorage.setItem('tech', u.tech); };
  document.getElementById('services').onclick = (e) => {
    const b = e.target.closest('[data-id]'); if (!b) return;
    u.serviceId = b.dataset.id; renderUpload();
  };
  document.getElementById('file').onchange = (e) => addFiles([...e.target.files]);
  document.getElementById('clear')?.addEventListener('click', () => { u.results = []; renderUpload(); });
  document.getElementById('go').onclick = sendSet;
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
      toast(`Couldn’t read ${f.name}`);
    }
    u.analyzing--;
    markDuplicates(u.results);
    if (location.hash.startsWith('#/upload') || !location.hash) renderUpload();
  }
}

async function sendSet() {
  const u = state.upload;
  u.sending = true;
  modal(`<div style="text-align:center"><div class="spinner"></div><h2>Picking the best shots</h2><p class="muted">Checking framing, background and house style, then writing captions.</p></div>`);
  try {
    const started = Date.now();
    const { post } = await api('/api/sets', {
      method: 'POST',
      body: {
        tech: u.tech, serviceId: u.serviceId,
        photos: u.results.map(({ id, name, dataUrl, width, height, checks, features, pixelReason, dropped, duplicateOf }) => ({ id, name, dataUrl, width, height, checks, features, pixelReason, dropped, duplicateOf })),
      },
    });
    console.info(`Set processed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    setPost(post);
    u.results = []; u.serviceId = null;
    modal(null);
    location.hash = `#/sent/${post.id}`;
  } catch (err) {
    modal(null); toast(err.message);
  } finally {
    u.sending = false;
  }
}

function renderSent(id) {
  const post = state.posts.find((p) => p.id === id);
  if (!post) return (location.hash = '#/upload');
  const picks = orderedPhotos(post);
  $app.innerHTML = `
    <h1>Sent to Tina ✓</h1>
    <p class="muted">She’ll review and post it. Here’s what we picked from your ${post.photos.length} photos.</p>
    <div class="grid">${picks.map((p, i) => `<div class="tile"><img src="${p.url}" alt=""><span class="num ${i ? '' : 'hero'}">${i ? i + 1 : '★'}</span><span class="tag ok">${esc(p.reason)}</span></div>`).join('')}</div>
    ${post.retakeTip ? `<div class="tip" style="margin-top:14px"><b>Tip for next time:</b> ${esc(post.retakeTip)}</div>` : ''}
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
    const hero = photo(p, p.heroId);
    const s = service(p.serviceId);
    const status = isOverdue(p) ? `<span class="status overdue">Overdue · ${fmtSlot(p.scheduledFor)}</span>`
      : p.status === 'ready' ? `<span class="status ready">${fmtSlot(p.scheduledFor)}</span>`
      : p.status === 'posted' ? `<span class="status posted">Posted ${new Date(p.postedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>`
      : `<span class="status needs_approval">Needs approval</span>`;
    return `<a class="card list-item" href="#/post/${p.id}">
      ${hero ? `<img src="${hero.url}" alt="">` : '<img alt="">'}
      <div class="meta"><div class="title">${esc(s?.name || 'Nail set')}</div>
        <div class="muted small" style="margin-bottom:6px">by ${esc(p.tech)} · ${[p.heroId, ...p.carouselIds].filter(Boolean).length} photos</div>${status}</div>
      <span class="chev">›</span></a>`;
  };

  const approved = state.posts.filter((p) => p.approvedAt);
  const avgSec = approved.length ? Math.round(approved.reduce((s, p) => s + (new Date(p.approvedAt) - new Date(p.createdAt)) / 1000, 0) / approved.length) : null;
  const done = state.posts.filter((p) => p.status !== 'needs_approval');
  const avgTaps = done.length ? (done.reduce((s, p) => s + (p.metrics?.taps || 0), 0) / done.length).toFixed(1) : '–';
  const fmtDur = (s) => (s == null ? '–' : s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`);

  $app.innerHTML = `
    <h1>Posts</h1>
    ${overdue.length ? `<div class="card" style="border-color:#E5B9B3"><b>${overdue.length} post${overdue.length > 1 ? 's are' : ' is'} overdue.</b> <span class="muted">Share ${overdue.length > 1 ? 'them' : 'it'} when you have a minute.</span>
      <div style="margin-top:10px">${overdue.map(item).join('')}</div></div>` : ''}
    <div class="seg" id="seg" style="margin-bottom:14px">
      <button data-t="needs_approval" class="${tab === 'needs_approval' ? 'on' : ''}">Needs approval (${by('needs_approval').length})</button>
      <button data-t="ready" class="${tab === 'ready' ? 'on' : ''}">Up next (${by('ready').length})</button>
      <button data-t="posted" class="${tab === 'posted' ? 'on' : ''}">Posted (${by('posted').length})</button>
    </div>
    ${tab === 'needs_approval' && list.length > 1 ? `<button class="btn-gold" id="approve-all" style="margin-bottom:14px">Approve all ${list.length}</button>` : ''}
    ${tab === 'ready' && list.length ? `<p class="muted small">One post a day: 12pm Mon–Thu, 7pm Fri–Sun (our guess at the best times).</p>` : ''}
    ${list.length ? list.map(item).join('') : `<div class="card muted" style="text-align:center">${{ needs_approval: 'Nothing waiting. New sets from the team show up here.', ready: 'No approved posts yet.', posted: 'Nothing posted yet.' }[tab]}</div>`}
    <div class="section-label">This week</div>
    <div class="card stats">
      <div><b>${fmtDur(avgSec)}</b><span>upload → approved</span></div>
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
    toast('All approved and spread out, one a day.'); renderPosts();
  });
}

function renderPost(id) {
  const post = state.posts.find((p) => p.id === id);
  if (!post) return (location.hash = '#/posts');
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
    ready: `<div class="note">${isOverdue(post) ? '<b style="color:var(--bad)">Overdue</b> · was' : 'Scheduled'} ${fmtSlot(post.scheduledFor)}</div>
      <button class="btn-primary" data-act="share-ig">Share to Instagram</button>
      <div class="row" style="margin-top:8px"><button class="btn-ghost" data-act="save">Save photos</button><button class="btn-ghost" data-act="copy">Copy caption</button></div>`,
    posted: `<div class="note">Posted ${new Date(post.postedAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
      <div class="row"><button class="btn-ghost" data-act="save">Save photos</button><button class="btn-ghost" data-act="copy">Copy caption</button></div>`,
  }[post.status];

  $app.innerHTML = `
    <a href="#/posts" class="muted small" style="text-decoration:none">‹ All posts</a>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin:8px 0 12px">
      <h1 style="margin:0">${esc(s?.name || 'Nail set')}</h1>
      <span class="status ${isOverdue(post) ? 'overdue' : post.status}">${isOverdue(post) ? 'Overdue' : { needs_approval: 'Needs approval', ready: 'Ready to post', posted: 'Posted' }[post.status]}</span>
    </div>
    <p class="muted small">by ${esc(post.tech)} · ${post.photos.length} photos uploaded</p>

    ${hero ? `<div class="hero"><img src="${hero.url}" alt="Hero photo"><div class="why"><span class="score">★ ${hero.score}</span>${esc(hero.reason)}</div></div>
      <details><summary>Why this one?</summary>${checkRows(hero)}</details>` : '<div class="card">No usable photos in this set.</div>'}
    ${post.retakeTip ? `<div class="tip" style="margin-top:10px"><b>These are a bit weak.</b> Tip for the team: ${esc(post.retakeTip)}</div>` : ''}

    <div class="section-label">Carousel · swipe order</div>
    <div class="strip">
      ${post.carouselIds.map((pid, i) => { const p = photo(post, pid); return `<div class="pick">
        <div class="tile"><img src="${p.url}" alt=""><span class="num">${i + 2}</span></div>
        <div class="reason"><span class="score">${p.score}</span>${esc(p.reason)}</div>
        <div class="acts"><button class="btn-ghost" data-hero="${p.id}">★ Hero</button><button class="btn-line" data-remove="${p.id}">Remove</button></div>
      </div>`; }).join('') || '<p class="muted small">Just the hero photo.</p>'}
    </div>

    ${others.length ? `<details><summary>Other photos (${others.length})</summary><div class="strip" style="margin-top:8px">
      ${others.map((p) => `<div class="pick"><div class="tile ${usable(p) ? '' : 'out'}"><img src="${p.url}" alt=""></div>
        <div class="reason">${p.score != null && usable(p) ? `<span class="score">${p.score}</span>` : ''}${esc(p.reason || '')}</div>
        <div class="acts"><button class="btn-ghost" data-add="${p.id}">Add</button><button class="btn-line" data-hero="${p.id}">★ Hero</button></div></div>`).join('')}
    </div></details>` : ''}

    <div class="section-label">Caption</div>
    <div class="card">
      <div class="seg" id="opts">${post.captions.options.map((o) => `<button data-k="${o.key}" class="${o.key === post.chosen ? 'on' : ''}">${o.key} · ${esc(o.label)}</button>`).join('')}</div>
      <div class="seg" id="chan" style="margin-top:8px"><button data-c="ig" class="${ch === 'ig' ? 'on' : ''}">Instagram</button><button data-c="fb" class="${ch === 'fb' ? 'on' : ''}">Facebook</button></div>
      ${state.view.editing
        ? `<textarea id="cap-edit" style="margin-top:12px">${esc(text)}</textarea><div class="row" style="margin-top:8px"><button class="btn-ghost" data-act="cancel-edit">Cancel</button><button class="btn-primary" data-act="save-edit">Save</button></div>`
        : `<div class="caption" id="cap">${esc(text)}</div>
           <div class="chips"><button class="chip" data-act="edit">✎ Edit</button><button class="chip" data-tweak="shorter">Shorter</button><button class="chip" data-tweak="playful">More playful</button><button class="chip" data-tweak="new">New options</button></div>`}
      ${post.status !== 'needs_approval' ? `<div style="margin-top:12px"><button class="btn-line" style="width:100%;min-height:44px;font-size:15px" data-act="share-fb">Share to Facebook</button></div>` : ''}
    </div>

    <div style="display:flex;justify-content:space-between;margin-top:6px">
      ${post.status === 'ready' ? '<button class="link" data-act="unapprove">Move back to review</button>' : '<span></span>'}
      ${post.status === 'ready' ? '<button class="link" data-act="mark-posted">Already posted it</button>' : ''}
      <button class="link" data-act="delete" style="color:var(--bad)">Delete set</button>
    </div>
    <p class="muted small">Photos are never edited. Instagram trims to 4:5 when you post.</p>
    <div class="bar"><div class="inner">${actionBar}</div></div>`;

  $app.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    try {
      if (d.hero) {
        const carousel = [post.heroId, ...post.carouselIds].filter((x) => x && x !== d.hero).slice(0, 4);
        await patch({ heroId: d.hero, carouselIds: carousel });
      } else if (d.remove) {
        await patch({ carouselIds: post.carouselIds.filter((x) => x !== d.remove) });
      } else if (d.add) {
        if (post.carouselIds.length >= 9) return toast('Instagram allows up to 10 photos.');
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
    if (a === 'copy') { await copyText(captionText(post)); return toast('Caption copied.'); }
    if (a === 'edit') { state.view.editing = true; return renderPost(id); }
    if (a === 'cancel-edit') { state.view.editing = false; return renderPost(id); }
    if (a === 'save-edit') {
      state.view.editing = false;
      return patch({ edit: { key: post.chosen, channel: state.view.channel, text: document.getElementById('cap-edit').value } });
    }
    if (a === 'approve') {
      const { post: p } = await api(`/api/posts/${id}/approve`, { method: 'POST', body: { taps: flushTaps() } });
      setPost(p); toast(`Approved. Up next ${fmtSlot(p.scheduledFor)}.`); return renderPost(id);
    }
    if (a === 'unapprove') { const { post: p } = await api(`/api/posts/${id}/unapprove`, { method: 'POST' }); setPost(p); return renderPost(id); }
    if (a === 'mark-posted') { state.awaitingConfirm = id; return askPosted(); }
    if (a === 'delete') {
      const m = modal(`<h2>Delete this set?</h2><p class="muted">The photos and captions will be removed from the app.</p><div class="row"><button class="btn-ghost" data-a="no">Keep</button><button class="btn-primary" data-a="yes" style="background:var(--bad)">Delete</button></div>`);
      m.onclick = async (ev) => {
        const x = ev.target.closest('[data-a]')?.dataset.a; if (!x) return;
        modal(null);
        if (x === 'yes') { await api(`/api/posts/${id}`, { method: 'DELETE' }); state.posts = state.posts.filter((p) => p.id !== id); updateBadge(); location.hash = '#/posts'; }
      };
    }
  }
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
  if (route === 'posts') return renderPosts();
  if (route === 'post') return renderPost(id);
  if (route === 'sent') return renderSent(id);
  return renderUpload();
}
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
  if (standalone || !mobile || localStorage.getItem('a2hs-seen')) return;
  const el = document.getElementById('a2hs');
  if (/android/i.test(navigator.userAgent)) el.querySelector('span').innerHTML = 'Tip: tap <b>⋮</b> then <b>Add to Home screen</b> to open this like an app.';
  el.hidden = false;
  document.getElementById('a2hs-close').onclick = () => { el.hidden = true; localStorage.setItem('a2hs-seen', '1'); };
}

// ---------- boot ----------
(async function boot() {
  state.config = await api('/api/config');
  state.posts = (await api('/api/posts')).posts;
  updateBadge();
  setupHint();
  render();
  // Keep the owner view fresh when sets arrive from the team.
  setInterval(async () => {
    if (!location.hash.startsWith('#/posts') || document.visibilityState !== 'visible') return;
    const { posts } = await api('/api/posts');
    if (JSON.stringify(posts.map((p) => p.id + p.status)) !== JSON.stringify(state.posts.map((p) => p.id + p.status))) {
      state.posts = posts; updateBadge(); renderPosts();
    }
  }, 8000);
})();
