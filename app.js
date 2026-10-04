'use strict';

// ---------- storage ----------
const LS = { data: 'gym.data', cfg: 'gym.cfg', pending: 'gym.pending' };
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  return {
    exercises: Array.isArray(d.exercises) ? d.exercises : [],
    entries: Array.isArray(d.entries) ? d.entries : [],
  };
}

let data = normalize(load(LS.data, null));
let cfg = Object.assign({ owner: '', repo: 'gym-data', token: '' }, load(LS.cfg, {}));
let pending = load(LS.pending, false);
let localVer = 0; // bumps on every local change, so a sync knows if edits landed mid-flight

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
const int = v => { const n = parseInt(v, 10); return n > 0 ? n : null; };
const fmtKg = kg => `${+kg.toFixed(2)}`;

function daysAgo(date) {
  const [y, m, d] = date.split('-').map(Number);
  const diff = Math.round((new Date(today()) - new Date(Date.UTC(y, m - 1, d))) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return `${diff}d ago`;
  if (diff < 60) return `${Math.round(diff / 7)}w ago`;
  return `${Math.round(diff / 30)}mo ago`;
}
function fmtDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });
}

// ---------- model ----------
const exercises = () => data.exercises.filter(e => !e.deleted);
const getEx = id => data.exercises.find(e => e.id === id && !e.deleted);
const entriesFor = id => data.entries.filter(e => e.ex === id && !e.deleted).sort((a, b) => (a.date < b.date ? -1 : 1));
const lastEntry = id => { const l = entriesFor(id); return l[l.length - 1]; };

function commit() {
  localVer++;
  save(LS.data, data);
  pending = true;
  save(LS.pending, true);
  scheduleSync();
}

function addExercise(name, sets, reps, kg) {
  const ex = { id: uid(), name, sets, reps, created: today(), t: Date.now() };
  data.exercises.push(ex);
  if (kg != null) putEntry(ex, kg);
  commit();
  return ex;
}

function putEntry(ex, kg) {
  const date = today();
  const fields = { kg, sets: ex.sets, reps: ex.reps, deleted: false, t: Date.now() };
  const existing = data.entries.find(e => e.ex === ex.id && e.date === date);
  if (existing) Object.assign(existing, fields);
  else data.entries.push({ ex: ex.id, date, ...fields });
}

function logKg(id, kg) {
  const ex = getEx(id);
  if (!ex) return;
  putEntry(ex, kg);
  commit();
}

// Last-write-wins per exercise id and per (exercise, date). Deletes are tombstones so they survive merges.
function merge(a, b) {
  const pick = (map, key, item) => {
    const prev = map.get(key);
    if (!prev || (item.t || 0) > (prev.t || 0)) map.set(key, item);
  };
  const ex = new Map(), en = new Map();
  for (const e of [...a.exercises, ...b.exercises]) pick(ex, e.id, e);
  for (const e of [...a.entries, ...b.entries]) pick(en, `${e.ex}|${e.date}`, e);
  return { exercises: [...ex.values()], entries: [...en.values()] };
}

// One record per line so commits in the data repo diff nicely.
function serialize(d) {
  const ex = [...d.exercises].sort((a, b) => (a.created + a.id < b.created + b.id ? -1 : 1));
  const en = [...d.entries].sort((a, b) => (a.date + a.ex < b.date + b.ex ? -1 : 1));
  const block = arr => arr.length ? '\n  ' + arr.map(x => JSON.stringify(x)).join(',\n  ') + '\n ' : '';
  return `{\n "exercises": [${block(ex)}],\n "entries": [${block(en)}]\n}\n`;
}

// ---------- GitHub sync ----------
const configured = () => !!(cfg.owner && cfg.repo && cfg.token);
let syncStatus = configured() ? (pending ? 'pending' : 'ok') : 'local';
let syncError = '';

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

async function gh(path, opts = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${cfg.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${path}`;
  return fetch(url, { ...opts, headers, cache: 'no-store' });
}

async function ghError(res) {
  let msg = '';
  try { msg = (await res.json()).message; } catch {}
  if (res.status === 401) return 'Token rejected (expired or wrong).';
  if (res.status === 403) return `Forbidden: ${msg || 'token lacks Contents read/write on this repo'}`;
  if (res.status === 404) return 'Repo not found, or the token has no access to it.';
  return `GitHub ${res.status}: ${msg}`;
}

async function pull() {
  const res = await gh('/contents/data.json');
  if (res.status === 404) {
    // Distinguish "file not created yet" from "no access to repo"
    const repo = await gh('');
    if (!repo.ok) throw new Error(await ghError(repo));
    return { data: normalize(null), sha: null };
  }
  if (!res.ok) throw new Error(await ghError(res));
  const j = await res.json();
  return { data: normalize(JSON.parse(b64decode(j.content))), sha: j.sha };
}

async function push(d, sha) {
  const body = { message: `log ${today()}`, content: b64encode(serialize(d)) };
  if (sha) body.sha = sha;
  const res = await gh('/contents/data.json', { method: 'PUT', body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) return false; // someone else wrote first: refetch and merge
  if (!res.ok) throw new Error(await ghError(res));
  return true;
}

let syncTimer = null, syncing = false, syncAgain = false;
function scheduleSync(delay = 400) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, delay);
}

async function sync() {
  if (!configured()) { setStatus('local'); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setStatus('syncing');
  try {
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      const remote = await pull();
      const before = serialize(data);
      data = merge(remote.data, data);
      const merged = serialize(data);
      save(LS.data, data);
      if (merged !== before) softRender();
      const ver = localVer;
      if (merged === serialize(remote.data)) done = true;
      else done = await push(data, remote.sha);
      if (done && ver === localVer) { pending = false; save(LS.pending, false); }
    }
    setStatus(pending ? 'pending' : 'ok');
    if (pending && !syncAgain) scheduleSync(2000);
  } catch (err) {
    syncError = err.message || String(err);
    setStatus(navigator.onLine === false || err instanceof TypeError ? 'offline' : 'error');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(0); }
  }
}

function setStatus(s) {
  syncStatus = s;
  if (s === 'ok' || s === 'syncing') syncError = '';
  const el = $('#sync');
  const labels = {
    ok: 'synced', syncing: 'syncing…', pending: 'pending',
    offline: pending ? 'offline · saved on phone' : 'offline', error: 'sync error', local: 'local only',
  };
  el.className = 'sync ' + s;
  $('.label', el).textContent = labels[s] || '';
  if (route().view === 'settings') renderSyncMsg();
}

// ---------- routing & rendering ----------
const app = $('#app');
function route() {
  const h = location.hash.slice(1);
  if (h === 'settings') return { view: 'settings' };
  if (h.startsWith('ex/')) return { view: 'detail', id: h.slice(3) };
  return { view: 'home' };
}

function render() {
  const r = route();
  if (r.view === 'settings') renderSettings();
  else if (r.view === 'detail' && getEx(r.id)) renderDetail(r.id);
  else renderHome();
}

// Re-render after a background sync without wiping something you're typing.
let renderDeferred = false;
function softRender() {
  const a = document.activeElement;
  if (a && a.tagName === 'INPUT' && app.contains(a)) { renderDeferred = true; return; }
  render();
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (renderDeferred && !(document.activeElement && document.activeElement.tagName === 'INPUT')) {
    renderDeferred = false;
    render();
  }
}, 0));

// ----- home -----
function renderHome(flashId) {
  const list = exercises();
  app.innerHTML = `
    <form class="add" id="add" autocomplete="off">
      <input name="name" placeholder="New exercise" enterkeyhint="next" autocapitalize="words">
      <input name="sets" inputmode="numeric" placeholder="3" enterkeyhint="next" aria-label="Sets">
      <span class="x">×</span>
      <input name="reps" inputmode="numeric" placeholder="8" enterkeyhint="next" aria-label="Reps">
      <input name="kg" inputmode="decimal" placeholder="kg" enterkeyhint="done" aria-label="Weight kg">
    </form>
    ${list.length ? `<ul class="list">${list.map(rowHtml).join('')}</ul>`
      : `<div class="empty">Add your first exercise above:<br>name, sets × reps, kg, then Enter.</div>`}
  `;
  wireAdd($('#add'));
  app.querySelectorAll('.row form').forEach(f => f.addEventListener('submit', onLog));
  if (flashId) {
    const row = app.querySelector(`.row[data-id="${CSS.escape(flashId)}"]`);
    if (row) { row.classList.add('saved'); setTimeout(() => row.classList.remove('saved'), 1200); }
  }
}

function rowHtml(ex) {
  const last = lastEntry(ex.id);
  const sub = `${ex.sets}×${ex.reps}` + (last ? ` · ${fmtKg(last.kg)} kg · ${daysAgo(last.date)}` : '');
  return `
    <li class="row" data-id="${esc(ex.id)}">
      <a class="name" href="#ex/${esc(ex.id)}"><b>${esc(ex.name)}</b><small>${esc(sub)}</small></a>
      <form autocomplete="off">
        <input inputmode="decimal" enterkeyhint="done" placeholder="${last ? fmtKg(last.kg) : 'kg'}" aria-label="kg for ${esc(ex.name)}">
        <button aria-label="Save">✓</button>
      </form>
    </li>`;
}

function onLog(e) {
  e.preventDefault();
  const id = e.target.closest('.row').dataset.id;
  const input = $('input', e.target);
  let kg = num(input.value);
  if (kg == null) { const last = lastEntry(id); if (!last) { input.focus(); return; } kg = last.kg; } // empty = same as last time
  input.blur();
  logKg(id, kg);
  renderHome(id);
}

function wireAdd(form) {
  const fields = ['name', 'sets', 'reps', 'kg'].map(n => form.elements[n]);
  const submit = () => {
    const name = fields[0].value.trim();
    if (!name) { fields[0].focus(); return; }
    const sets = int(fields[1].value) || 3;
    const reps = int(fields[2].value) || 8;
    const kg = num(fields[3].value);
    document.activeElement && document.activeElement.blur();
    const ex = addExercise(name, sets, reps, kg);
    renderHome(ex.id);
  };
  // Enter moves to the next empty field; when nothing after it is empty, it saves.
  fields.forEach((f, i) => f.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (i === 0 && !f.value.trim()) return;
    const next = fields.slice(i + 1).find(x => !x.value.trim());
    if (next) next.focus(); else submit();
  }));
  form.addEventListener('submit', e => { e.preventDefault(); submit(); });
}

// ----- detail -----
function renderDetail(id) {
  const ex = getEx(id);
  const list = entriesFor(id);
  const kgs = list.map(e => e.kg);
  const best = kgs.length ? Math.max(...kgs) : null;
  const first = list[0], last = list[list.length - 1];
  app.innerHTML = `
    <a href="#" class="back">‹ All exercises</a>
    <h2>${esc(ex.name)}</h2>
    <div class="chart">${chartSvg(list)}</div>
    ${list.length ? `<div class="stats">
      <div><small>Latest</small><b>${fmtKg(last.kg)} kg</b></div>
      <div><small>Best</small><b>${fmtKg(best)} kg</b></div>
      <div><small>Change</small><b>${last.kg - first.kg >= 0 ? '+' : ''}${fmtKg(last.kg - first.kg)} kg</b></div>
    </div>` : ''}
    <h3>Edit</h3>
    <form class="edit" id="edit" autocomplete="off">
      <input name="name" value="${esc(ex.name)}" aria-label="Name">
      <input name="sets" inputmode="numeric" value="${ex.sets}" aria-label="Sets">
      <span class="x">×</span>
      <input name="reps" inputmode="numeric" value="${ex.reps}" aria-label="Reps">
      <button>Save</button>
    </form>
    <h3>History (${list.length})</h3>
    <ul class="entries">
      ${[...list].reverse().map(e => `
        <li data-date="${esc(e.date)}">
          <span class="d">${esc(fmtDate(e.date))}</span>
          <span class="k">${fmtKg(e.kg)} kg</span>
          <span class="sr">${e.sets}×${e.reps}</span>
          <button aria-label="Delete entry">×</button>
        </li>`).join('') || '<li class="help">No entries yet.</li>'}
    </ul>
    <div class="btns" style="margin-top:24px"><button class="danger" id="del">Delete exercise</button></div>
  `;
  $('#edit').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.elements;
    ex.name = f.name.value.trim() || ex.name;
    ex.sets = int(f.sets.value) || ex.sets;
    ex.reps = int(f.reps.value) || ex.reps;
    ex.t = Date.now();
    commit();
    location.hash = '';
  });
  app.querySelectorAll('.entries button').forEach(b => b.addEventListener('click', () => {
    const date = b.closest('li').dataset.date;
    if (!confirm(`Delete entry for ${fmtDate(date)}?`)) return;
    const entry = data.entries.find(e => e.ex === id && e.date === date);
    Object.assign(entry, { deleted: true, t: Date.now() });
    commit();
    renderDetail(id);
  }));
  $('#del').addEventListener('click', () => {
    if (!confirm(`Delete "${ex.name}" and all its history?`)) return;
    const t = Date.now();
    Object.assign(ex, { deleted: true, t });
    data.entries.filter(e => e.ex === id).forEach(e => Object.assign(e, { deleted: true, t }));
    commit();
    location.hash = '';
  });
}

function chartSvg(list) {
  const W = 340, H = 190, L = 38, R = 12, T = 14, B = 26;
  if (!list.length) return `<svg viewBox="0 0 ${W} ${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle">No data yet</text></svg>`;
  const ts = list.map(e => { const [y, m, d] = e.date.split('-').map(Number); return Date.UTC(y, m - 1, d); });
  const kgs = list.map(e => e.kg);
  let lo = Math.min(...kgs), hi = Math.max(...kgs);
  if (hi - lo < 5) { const mid = (hi + lo) / 2; lo = mid - 2.5; hi = mid + 2.5; }
  const padY = (hi - lo) * 0.1; lo = Math.max(0, lo - padY); hi += padY;
  const t0 = ts[0], t1 = ts[ts.length - 1];
  const x = t => t1 === t0 ? (L + W - R) / 2 : L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = k => T + (1 - (k - lo) / (hi - lo)) * (H - T - B);
  const ticks = [lo, (lo + hi) / 2, hi];
  const pts = list.map((e, i) => [x(ts[i]), y(e.kg)]);
  const short = d => fmtDate(d).replace(/ \d{2}$/, '');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight over time">
    ${ticks.map(k => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(k)}" y2="${y(k)}"/>
      <text x="${L - 6}" y="${y(k) + 4}" text-anchor="end">${Math.round(k)}</text>`).join('')}
    <polyline class="ln" points="${pts.map(p => p.join(',')).join(' ')}"/>
    ${pts.map(p => `<circle class="pt" cx="${p[0]}" cy="${p[1]}" r="${list.length > 40 ? 2 : 3.5}"/>`).join('')}
    <text x="${L}" y="${H - 6}">${esc(short(list[0].date))}</text>
    ${list.length > 1 ? `<text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(short(list[list.length - 1].date))}</text>` : ''}
  </svg>`;
}

// ----- settings -----
function renderSettings() {
  app.innerHTML = `
    <a href="#" class="back">‹ Back</a>
    <h2>Settings</h2>
    <p class="help">Your data is saved to <code>data.json</code> in a <b>private</b> GitHub repo.
      The token stays on this device only. Use a fine-grained token limited to that one repo,
      with <b>Contents: Read and write</b>.
      <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create token ↗</a></p>
    <form id="cfg" autocomplete="off">
      <label class="field"><span>GitHub username</span><input name="owner" value="${esc(cfg.owner)}" autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>Data repo</span><input name="repo" value="${esc(cfg.repo)}" autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>Token</span><input name="token" type="password" value="${esc(cfg.token)}" placeholder="github_pat_…" autocapitalize="off" spellcheck="false"></label>
      <div class="btns">
        <button>Save &amp; sync</button>
        <button type="button" class="ghost" id="forget">Forget token</button>
      </div>
    </form>
    <div class="msg" id="msg"></div>
    <h3>Backup</h3>
    <div class="btns">
      <button type="button" class="ghost" id="export">Export JSON</button>
      <button type="button" class="ghost" id="importBtn">Import JSON</button>
      <input type="file" id="import" accept="application/json,.json" hidden>
    </div>
    <p class="help">${exercises().length} exercises · ${data.entries.filter(e => !e.deleted).length} entries</p>
  `;
  renderSyncMsg();
  $('#cfg').addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target.elements;
    cfg = { owner: f.owner.value.trim(), repo: f.repo.value.trim(), token: f.token.value.trim() };
    save(LS.cfg, cfg);
    pending = true; save(LS.pending, true); // push whatever is local into the repo
    sync();
  });
  $('#forget').addEventListener('click', () => {
    cfg.token = ''; save(LS.cfg, cfg); setStatus('local'); renderSettings();
  });
  $('#export').addEventListener('click', () => {
    const blob = new Blob([serialize(data)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `gym-${today()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#importBtn').addEventListener('click', () => $('#import').click());
  $('#import').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      data = merge(data, normalize(JSON.parse(await file.text())));
      commit();
      renderSettings();
      $('#msg').textContent = 'Imported and merged.';
    } catch (err) { alert('Could not read that file: ' + err.message); }
  });
}

function renderSyncMsg() {
  const el = $('#msg');
  if (!el) return;
  const text = {
    local: 'Not connected: data is only on this device.',
    syncing: 'Syncing…',
    ok: '✓ Connected and synced.',
    pending: 'Changes waiting to sync.',
    offline: 'Offline. Changes are saved on this device and will sync when back online.',
    error: 'Sync failed: ' + syncError,
  }[syncStatus];
  el.textContent = text || '';
  el.className = 'msg' + (syncStatus === 'ok' ? ' ok' : syncStatus === 'error' ? ' err' : '');
}

// ---------- boot ----------
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
window.addEventListener('online', () => scheduleSync(0));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(0); });
render();
setStatus(syncStatus);
if (configured()) scheduleSync(0);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
