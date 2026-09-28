// Dualarr web UI — plain ES modules, no build step.

const view = document.getElementById('view');
const dialog = document.getElementById('dialog');

// ---------- helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The server build this page was loaded from (see X-Dualarr-Build on every response).
const PAGE_BUILD = document.querySelector('meta[name="dualarr-build"]')?.content || '';
let reloading = false;

/** Dualarr was updated (or restarted) since this page loaded: reload to get the new UI. */
function checkBuild(res) {
  const build = res.headers.get('x-dualarr-build');
  if (!build || !PAGE_BUILD || build === PAGE_BUILD || reloading) return false;
  reloading = true;
  toast('Dualarr was updated — reloading…');
  setTimeout(() => location.reload(), 800);
  return true;
}

async function api(path, opts = {}) {
  // X-Dualarr: the server only accepts changes from a logged-in browser that sends it.
  const init = { ...opts, headers: { 'Content-Type': 'application/json', 'X-Dualarr': '1', ...(opts.headers || {}) } };
  if (opts.body !== undefined && typeof opts.body !== 'string') init.body = JSON.stringify(opts.body);
  const res = await fetch(path, init);
  // A write from an out-of-date page may have been refused or misread: stop and reload instead.
  if (checkBuild(res) && (init.method || 'GET') !== 'GET') throw new Error('Dualarr was updated — reloading the page');
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401 && data?.code && !path.startsWith('/api/auth/')) {
    clearTimeout(pollTimer);
    if (data.code === 'setup') viewCreateAccount();
    else viewLogin('Your session ended — please log in again.');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), isError ? 7000 : 3500);
}

const ICONS = {
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  ext: '<path d="M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
};
const icon = (n) => `<svg class="ico" viewBox="0 0 24 24">${ICONS[n]}</svg>`;

function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const fmtNext = (iso) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const plural = (n, word, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The clipboard API needs HTTPS; Unraid UIs are usually plain HTTP on the LAN.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

// ---------- vocabulary ----------

const VERDICTS = {
  dual: ['Dual audio', 'Japanese and English audio, with subtitles'],
  subbed: ['Subbed', 'Japanese audio with subtitles — waiting for the dub'],
  noSubs: ['No subtitles', 'Japanese audio, but no (matching) subtitle track'],
  noJapanese: ['No Japanese audio', 'No Japanese audio track — e.g. an English-only dub'],
  unknown: ['Unknown', 'Sonarr has no media info for it, or its audio tracks have no language'],
};
const REPLACEABLE = ['noSubs', 'noJapanese'];
const STATES = {
  done: 'Done',
  waiting: 'Waiting for dub',
  problem: 'Problems',
  unknown: 'Unknown',
  empty: 'No files',
};
const TABS = [
  ['all', 'All'],
  ['waiting', 'Waiting for dub'],
  ['problem', 'Problems'],
  ['done', 'Done'],
  ['unknown', 'Unknown'],
];
const SUBTITLE_LANGUAGES = { any: 'Any language', en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', ar: 'Arabic', ru: 'Russian' };
const NOTIFIER_TYPES = {
  discord: { label: 'Discord', fields: [['webhookUrl', 'Webhook URL', 'https://discord.com/api/webhooks/…', true]] },
  telegram: { label: 'Telegram', fields: [['botToken', 'Bot token', '123456:ABC…', true], ['chatId', 'Chat ID', '-1001234567890']] },
  ntfy: { label: 'ntfy', fields: [['server', 'Server', 'https://ntfy.sh'], ['topic', 'Topic', 'dualarr'], ['token', 'Access token (optional)', '', true]] },
  gotify: { label: 'Gotify', fields: [['server', 'Server URL', 'http://192.168.1.10:8070'], ['token', 'App token', '', true]] },
  webhook: { label: 'Webhook (JSON)', fields: [['url', 'URL', 'http://…']] },
};
const JOBS = {
  schedule: 'Scheduled scan',
  scan: 'Scanning library',
  rules: 'Rescanning with the new rules',
  search: 'Searching',
  replace: 'Replacing files',
  setup: 'Setting up Sonarr',
};

const verdictBadge = (k, n, withLabel = true) =>
  `<span class="vb v-${k}" title="${esc(VERDICTS[k][1])}"><i></i>${n !== undefined ? `${n.toLocaleString()}${withLabel ? ' ' : ''}` : ''}${withLabel ? esc(VERDICTS[k][0]) : ''}</span>`;
const stateBadge = (s) => `<span class="vb s-${s}"><i></i>${esc(STATES[s])}</span>`;
const langsText = (arr) => (arr?.length ? arr.join(' · ') : '—');

// ---------- global state ----------

const state = { settings: null, status: null, tab: 'all', filter: '' };

async function loadSettings() {
  state.settings = await api('/api/settings');
}
const sonarrConnected = () => !!(state.settings?.sonarrUrl && state.settings?.sonarrApiKeySet);

// ---------- status bar & polling ----------

const statusEl = document.getElementById('status');
let pollTimer = null;
let wasRunning = false;

function renderStatus() {
  const s = state.status;
  if (!s) return;
  let dot = 'dot';
  let text;
  if (s.running) {
    dot += ' run';
    text = `${JOBS[s.running] || 'Working'}…`;
  } else {
    if (s.lastRun) dot += s.lastRun.status === 'ok' ? ' ok' : s.lastRun.status === 'error' ? ' err' : '';
    text = s.nextRun ? `Next scan ${fmtNext(s.nextRun)}` : 'Scheduled scan off';
  }
  statusEl.innerHTML = `<span class="${dot}"></span><span>${esc(text)}</span>`;
  statusEl.title = `Timezone: ${s.timezone}`;
  const scan = document.getElementById('scan-now');
  if (scan) {
    scan.disabled = !!s.running;
    scan.classList.toggle('loading', !!s.running);
  }
}

async function pollStatus() {
  clearTimeout(pollTimer);
  try {
    state.status = await api('/api/status');
    renderStatus();
    if (wasRunning && !state.status.running) {
      const r = state.status.lastRun;
      if (['scan', 'schedule', 'rules'].includes(r?.trigger)) {
        toast(r.status === 'ok' ? 'Scan finished' : r.status === 'error' ? `Scan failed: ${r.summary?.error}` : 'Scan finished with warnings — see Activity', r.status === 'error');
      }
      if (/^#\/?$|^#\/activity|^$/.test(location.hash)) route();
    }
    wasRunning = !!state.status.running;
  } catch {
    statusEl.innerHTML = '<span class="dot err"></span><span>Server unreachable</span>';
  }
  pollTimer = setTimeout(pollStatus, state.status?.running ? 2000 : 60_000);
}

/** After starting a background job: poll quickly until it ends. */
function watchJob() {
  wasRunning = true;
  setTimeout(pollStatus, 600);
}

// ---------- router ----------

let renderToken = 0;
const routes = [
  [/^#?\/?$/, (t) => viewLibrary(t)],
  [/^#\/settings$/, () => viewSettings()],
  [/^#\/activity$/, () => viewActivity()],
];

async function route() {
  const hash = location.hash || '#/';
  const section = hash.startsWith('#/settings') ? 'settings' : hash.startsWith('#/activity') ? 'activity' : 'library';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  const token = ++renderToken;
  view.onclick = null;
  view.oninput = null;
  bare(false);
  for (const [re, fn] of routes) {
    if (!re.test(hash)) continue;
    try {
      await fn(token);
    } catch (e) {
      if (token === renderToken) view.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`;
    }
    return;
  }
  view.innerHTML = '<div class="empty"><h2>Page not found</h2><p><a href="#/">Back to the library</a></p></div>';
}
window.addEventListener('hashchange', route);

const loadingBlock = (msg) => `<div class="loading-block"><div class="spinner"></div><div>${esc(msg)}</div></div>`;

// ---------- dialogs ----------

function openDialog(html, onClose) {
  dialog.innerHTML = html;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', async () => resolve(await onClose(dialog.returnValue)), { once: true });
  });
}

/** A yes/no question in the app's own dialog; resolves true when confirmed. */
function confirmDialog({ title, body, ok, danger = false }) {
  return openDialog(
    `<form method="dialog">
      <h2>${esc(title)}</h2>
      ${body}
      <div class="actions">
        <button class="btn btn-ghost" value="cancel">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok" autofocus>${esc(ok)}</button>
      </div>
    </form>`,
    (v) => v === 'ok',
  );
}

// ---------- library ----------

const seriesUrl = (lib, s) => (lib.sonarrUrl && s.titleSlug ? `${lib.sonarrUrl}/series/${encodeURIComponent(s.titleSlug)}` : null);
const inTab = (s, tab) => tab === 'all' || s.state === tab || (tab === 'unknown' && s.state === 'empty');

async function viewLibrary(token) {
  view.innerHTML = loadingBlock('Loading library…');
  const lib = await api('/api/library');
  if (token !== renderToken) return;
  const t = lib.totals;
  const expanded = new Map(); // series id -> its files (once loaded)

  if (!sonarrConnected()) {
    view.innerHTML = `<div class="empty"><h2>Connect Sonarr first</h2><p>Dualarr checks the anime Sonarr already has on disk.</p><a class="btn btn-primary" href="#/settings">Open Settings</a></div>`;
    return;
  }

  const searchable = () => lib.series.filter((s) => s.monitored && s.needsSearch);
  const totalFiles = Object.values(t.files).reduce((a, b) => a + b, 0);
  const running = !!state.status?.running;

  const tiles = () => `
    <div class="tiles">
      <div class="tile" style="--c:var(--ok)"><b>${t.states.done.toLocaleString()}</b><span>Series done</span></div>
      <div class="tile" style="--c:var(--sub)"><b>${t.states.waiting.toLocaleString()}</b><span>Waiting for the dub</span></div>
      <div class="tile" style="--c:var(--err)"><b>${t.states.problem.toLocaleString()}</b><span>With problems</span></div>
      <div class="tile" style="--c:var(--faint)"><b>${(t.states.unknown + t.states.empty).toLocaleString()}</b><span>Unknown or empty</span></div>
    </div>
    <div class="file-counts"><span>${plural(totalFiles, 'file')}:</span>${Object.keys(VERDICTS).map((k) => verdictBadge(k, t.files[k])).join('')}</div>`;

  const unknownHint = () =>
    t.files.unknown && t.files.unknown >= Math.max(5, totalFiles * 0.1)
      ? `<div class="notice">${plural(t.files.unknown, 'file')} can’t be checked because Sonarr has no language info for them. In Sonarr, turn on <b>Settings → Media Management → Analyse video files</b> (show advanced settings), then refresh the series and scan again.</div>`
      : '';

  const rowHtml = (s) => {
    const url = seriesUrl(lib, s);
    const badges = Object.keys(VERDICTS)
      .filter((k) => s.counts[k])
      .map((k) => verdictBadge(k, s.counts[k], false))
      .join('');
    const open = expanded.has(s.id);
    return `<tr class="series${open ? ' open' : ''}" data-row="${s.id}">
        <td class="hide-sm" style="width:62px">${s.poster ? `<img class="poster" src="${esc(s.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="poster none">—</div>'}</td>
        <td>
          ${url ? `<a class="title" href="${esc(url)}" target="_blank" rel="noopener" data-stop>${esc(s.title)}${icon('ext')}</a>` : `<span class="title">${esc(s.title)}</span>`}
          <div class="sub">${[s.year, plural(s.total, 'file'), s.monitored ? '' : 'unmonitored'].filter(Boolean).join(' · ')}</div>
        </td>
        <td><div class="vbs">${badges || '<span class="faint">—</span>'}</div></td>
        <td class="hide-sm">${stateBadge(s.state)}</td>
        <td class="when hide-md">${esc(ago(s.scannedAt))}</td>
        <td class="when hide-md">${esc(ago(s.searchedAt))}</td>
        <td class="acts">
          ${s.needsSearch ? `<button class="btn btn-sm" type="button" data-search="${s.id}" title="Ask Sonarr to search for better releases">${icon('search')}<span class="hide-sm">Search</span></button>` : ''}
          <button class="btn btn-sm btn-ghost btn-icon" type="button" title="Show files">${icon('chev').replace('class="ico"', 'class="ico chev"')}</button>
        </td>
      </tr>
      ${open ? `<tr class="detail" data-detail="${s.id}"><td colspan="7">${detailHtml(s, expanded.get(s.id))}</td></tr>` : ''}`;
  };

  const detailHtml = (s, detail) => {
    if (!detail) return loadingBlock('Loading files…');
    if (detail.error) return `<div class="detail-head" style="color:var(--err)">${esc(detail.error)}</div>`;
    const files = detail.files.filter((f) => f.status !== 'dual');
    const bad = files.filter((f) => REPLACEABLE.includes(f.status));
    const head = `<div class="detail-head">
        <span>${files.length ? `${plural(files.length, 'file')} without dual audio` : 'Every file has dual audio.'}</span>
        <span class="spacer"></span>
        ${bad.length > 1 ? `<button class="btn btn-sm btn-danger" type="button" data-replace="${s.id}" data-files="${bad.map((f) => f.id).join(',')}">${icon('swap')}Replace all ${bad.length}</button>` : ''}
      </div>`;
    if (!files.length) return head;
    return `${head}
      <table class="files">
        <thead><tr><th style="width:40px">S</th><th>File</th><th>Audio</th><th>Subtitles</th><th>Verdict</th><th></th></tr></thead>
        <tbody>${files
          .map(
            (f) => `<tr>
              <td class="mono">${esc(f.season)}</td>
              <td><div class="path">${esc(f.path)}</div>${f.release ? `<div class="rel">${esc(f.release)}</div>` : ''}${f.quality ? `<div class="rel">${esc(f.quality)}${f.score ? ` · score ${esc(f.score)}` : ''}</div>` : ''}</td>
              <td class="langs">${esc(langsText(f.audio))}</td>
              <td class="langs">${esc(langsText(f.subs))}</td>
              <td>${verdictBadge(f.status)}</td>
              <td style="text-align:right">${REPLACEABLE.includes(f.status) ? `<button class="btn btn-sm btn-danger" type="button" data-replace="${s.id}" data-files="${f.id}" title="Blocklist this release, delete the file and search again">${icon('swap')}Replace</button>` : ''}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>`;
  };

  const tableHtml = () => {
    const q = state.filter.trim().toLowerCase();
    const rows = lib.series.filter((s) => inTab(s, state.tab) && (!q || s.title.toLowerCase().includes(q)));
    if (!rows.length) return `<div class="empty"><h2>Nothing here</h2><p>${q ? 'No series match that search.' : 'No series in this group.'}</p></div>`;
    return `<table class="lib">
        <thead><tr><th class="hide-sm"></th><th>Series</th><th>Files</th><th class="hide-sm">State</th><th class="hide-md">Scanned</th><th class="hide-md">Searched</th><th></th></tr></thead>
        <tbody>${rows.map(rowHtml).join('')}</tbody>
      </table>`;
  };
  const tabsHtml = () =>
    TABS.map(([k, label]) => `<button type="button" data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${label}<span class="n">${lib.series.filter((s) => inTab(s, k)).length}</span></button>`).join('');

  const renderList = () => {
    view.querySelector('#lib-tabs').innerHTML = tabsHtml();
    view.querySelector('#lib-table').innerHTML = tableHtml();
  };

  const scanned = lib.series.length > 0;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Library</h1><p>${scanned ? `${plural(t.series, 'series', 'series')} checked · last scan ${esc(ago(lib.series.reduce((m, s) => (s.scannedAt > m ? s.scannedAt : m), '')))}` : 'Not scanned yet.'}</p></div>
      <div class="page-actions">
        ${scanned ? `<button class="btn" type="button" id="search-all"${searchable().length ? '' : ' disabled'}>${icon('search')}Search all that need it</button>` : ''}
        <button class="btn btn-primary${running ? ' loading' : ''}" type="button" id="scan-now"${running ? ' disabled' : ''}>${icon('refresh')}Scan now</button>
      </div>
    </div>
    ${
      scanned
        ? `${tiles()}${unknownHint()}
          <div class="lib-bar">
            <div class="tabs" id="lib-tabs"></div>
            <span class="spacer"></span>
            <input class="input" id="lib-filter" type="search" placeholder="Filter by title" value="${esc(state.filter)}" />
          </div>
          <div id="lib-table"></div>`
        : `<div class="empty"><h2>No scan yet</h2><p>Scan to read the audio and subtitle languages of every anime file in Sonarr.</p></div>`
    }`;
  if (scanned) renderList();

  const rerenderRow = (id) => {
    const s = lib.series.find((x) => x.id === id);
    const tr = view.querySelector(`[data-row="${id}"]`);
    if (!s || !tr) return;
    view.querySelector(`[data-detail="${id}"]`)?.remove();
    tr.outerHTML = rowHtml(s);
  };

  view.oninput = (e) => {
    if (e.target.id !== 'lib-filter') return;
    state.filter = e.target.value;
    view.querySelector('#lib-table').innerHTML = tableHtml();
  };

  view.onclick = async (e) => {
    const b = e.target.closest('button,[data-stop],[data-row]');
    if (!b || b.hasAttribute('data-stop')) return;
    if (b.id === 'scan-now') {
      try {
        await api('/api/scan', { method: 'POST' });
        toast('Scanning the library…');
        b.disabled = true;
        b.classList.add('loading');
        watchJob();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    if (b.id === 'search-all') {
      const n = searchable().length;
      const ok = await confirmDialog({
        title: `Search for ${plural(n, 'series', 'series')}?`,
        body: `<p class="muted">Dualarr asks Sonarr to search for dual audio (and for files that break the rules) in every monitored series that needs it. Whole seasons are searched as season packs. This can mean a lot of indexer requests at once — the nightly search does ${state.settings.searchPerRun} series at a time instead.</p>`,
        ok: 'Search',
      });
      if (!ok) return;
      b.disabled = true;
      try {
        const r = await api('/api/search', { method: 'POST', body: {} });
        toast(`Sonarr is searching ${plural(r.summary.searched.length, 'series', 'series')}${r.summary.warnings.length ? ` (${plural(r.summary.warnings.length, 'warning')} — see Activity)` : ''}`, r.status !== 'ok');
        route();
      } catch (err) {
        toast(err.message, true);
        b.disabled = false;
      }
      return;
    }
    if (b.dataset.tab) {
      state.tab = b.dataset.tab;
      renderList();
      return;
    }
    if (b.dataset.search) {
      const id = Number(b.dataset.search);
      b.disabled = true;
      try {
        const r = await api('/api/search', { method: 'POST', body: { ids: [id] } });
        const s = r.summary.searched[0];
        if (s) {
          const what = [s.seasons && plural(s.seasons, 'season'), s.episodes && plural(s.episodes, 'episode')].filter(Boolean).join(' and ');
          toast(`Sonarr is searching ${s.title}${what ? ` (${what})` : ''}`);
          const row = lib.series.find((x) => x.id === id);
          row.searchedAt = new Date().toISOString();
          rerenderRow(id);
        } else toast(r.summary.warnings[0] || 'Nothing was searched', true);
      } catch (err) {
        toast(err.message, true);
        b.disabled = false;
      }
      return;
    }
    if (b.dataset.replace) {
      const id = Number(b.dataset.replace);
      const ids = b.dataset.files.split(',').map(Number);
      const files = expanded.get(id)?.files.filter((f) => ids.includes(f.id)) || [];
      const ok = await confirmDialog({
        title: `Replace ${plural(ids.length, 'file')}?`,
        body: `<p class="muted">For each file, Dualarr marks the release that produced it as failed in Sonarr (so it is blocklisted and not grabbed again), <b>deletes the file</b>, and asks Sonarr to search for the episode again.</p>
          <ul>${files.map((f) => `<li>${esc(f.path)} — ${esc(VERDICTS[f.status][0])}</li>`).join('')}</ul>`,
        ok: 'Delete and replace',
        danger: true,
      });
      if (!ok) return;
      b.disabled = true;
      try {
        const r = await api(`/api/series/${id}/replace`, { method: 'POST', body: { fileIds: ids } });
        const rep = r.summary.replaced;
        toast(`Deleted ${plural(rep.files, 'file')}${rep.blocklisted ? `, blocklisted ${rep.blocklisted}` : ''} — Sonarr is searching ${plural(rep.episodes, 'episode')}`, r.status !== 'ok');
        if (r.series) {
          const { files: seriesFiles, ...row } = r.series;
          Object.assign(lib.series.find((x) => x.id === id), row);
          expanded.set(id, { files: seriesFiles });
        }
        rerenderRow(id);
      } catch (err) {
        toast(err.message, true);
        b.disabled = false;
      }
      return;
    }
    // Anywhere else on a row: show or hide its files.
    const tr = e.target.closest('[data-row]');
    if (!tr) return;
    const id = Number(tr.dataset.row);
    if (expanded.has(id)) {
      expanded.delete(id);
      rerenderRow(id);
      return;
    }
    expanded.set(id, null);
    rerenderRow(id);
    try {
      expanded.set(id, await api(`/api/series/${id}`));
    } catch (err) {
      expanded.set(id, { error: err.message });
    }
    if (expanded.has(id)) rerenderRow(id);
  };
}

// ---------- settings ----------

const SCHEDULES = [
  ['0 4 * * *', 'Every day at 4 AM'],
  ['0 4 * * 1,4', 'Mondays and Thursdays at 4 AM'],
  ['0 4 * * 1', 'Every Monday at 4 AM'],
  ['0 */12 * * *', 'Every 12 hours'],
  ['', 'Off — manual scans only'],
];

async function viewSettings() {
  await loadSettings();
  state.status = await api('/api/status');
  const s = state.settings;
  const st = state.status;
  const preset = SCHEDULES.some(([v]) => v === s.schedule) ? s.schedule : 'custom';

  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Server time zone: ${esc(st.timezone)} · Dualarr ${esc(st.version)}</p></div></div>
    <form id="settings-form" autocomplete="off">
      <div class="settings">
        <div class="panel">
          <div class="panel-head"><div><h2>Sonarr</h2><p>Where your anime lives. Dualarr reads its files and asks it to search.</p></div></div>
          <div class="panel-body">
            <div class="field">
              <label for="sonarr-url">URL</label>
              <input class="input" id="sonarr-url" name="sonarrUrl" value="${esc(s.sonarrUrl)}" placeholder="http://192.168.1.10:8989" />
              <span class="hint">Use your server’s address, not <code>localhost</code> — inside Docker, “localhost” is Dualarr itself.</span>
            </div>
            <div class="field">
              <label for="sonarr-key">API key</label>
              <input class="input mono" id="sonarr-key" name="sonarrApiKey" type="password" autocomplete="new-password"
                placeholder="${s.sonarrApiKeySet ? 'Saved — leave blank to keep' : 'Sonarr → Settings → General → API Key'}" />
            </div>
            <div class="row" style="flex:none">
              <button type="button" class="btn btn-sm" id="sonarr-test" style="flex:none">Test</button>
              <span class="test-result" id="sonarr-res"></span>
              ${s.sonarrApiKeySet ? '<button type="button" class="btn btn-sm btn-ghost btn-danger" id="sonarr-forget" style="flex:none">Forget key</button>' : ''}
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div><h2>Rules</h2><p>What every anime file should have. Changing these rescans the library.</p></div></div>
          <div class="panel-body">
            <div class="field">
              <label for="scope">Check</label>
              <select class="select" id="scope" name="scope">
                <option value="anime"${s.scope === 'anime' ? ' selected' : ''}>Series with the Anime series type</option>
                <option value="japanese"${s.scope === 'japanese' ? ' selected' : ''}>Anime series, and any series originally in Japanese</option>
              </select>
            </div>
            <label class="check"><input type="checkbox" name="requireSubtitles"${s.requireSubtitles ? ' checked' : ''} />
              <span><b>Require subtitles</b><span class="hint">A file with Japanese audio but no subtitle track counts as a problem. “HardSub” in the release name counts as subtitled.</span></span></label>
            <div class="field">
              <label for="sub-lang">Subtitle language</label>
              <select class="select" id="sub-lang" name="subtitleLanguage">
                ${Object.entries(SUBTITLE_LANGUAGES).map(([k, v]) => `<option value="${k}"${s.subtitleLanguage === k ? ' selected' : ''}>${v}</option>`).join('')}
              </select>
              <span class="hint">A signs & songs track looks the same as full subtitles to Sonarr, so it counts too.</span>
            </div>
          </div>
        </div>

        <div class="panel wide" id="setup-panel">
          <div class="panel-head"><div><h2>Sonarr setup</h2><p>Two custom formats that make Sonarr prefer dual audio and never grab an English-only dub, scored in the quality profiles you pick.</p></div></div>
          <div class="panel-body" id="setup-body">${sonarrConnected() ? loadingBlock('Reading Sonarr’s quality profiles…') : '<span class="hint">Connect Sonarr above and save first.</span>'}</div>
        </div>

        <div class="panel">
          <div class="panel-head"><div><h2>Schedule & searching</h2><p>A scheduled scan checks every file, then searches a few series that need it.</p></div></div>
          <div class="panel-body">
            <div class="field">
              <label for="sched-preset">Scan</label>
              <select class="select" id="sched-preset">
                ${SCHEDULES.map(([v, l]) => `<option value="${v}"${preset === v ? ' selected' : ''}>${l}</option>`).join('')}
                <option value="custom"${preset === 'custom' ? ' selected' : ''}>Custom (cron)…</option>
              </select>
            </div>
            <div class="field${preset === 'custom' ? '' : ' hidden'}" id="cron-field">
              <label for="cron">Cron expression</label>
              <input class="input mono" id="cron" name="schedule" value="${esc(s.schedule)}" placeholder="0 4 * * *" />
              <span class="hint">minute hour day month weekday — e.g. <code>30 4 * * *</code> is 4:30 AM daily.</span>
            </div>
            <span class="hint">${st.nextRun ? `Next scan: ${esc(new Date(st.nextRun).toLocaleString())}` : 'No scheduled scans.'}</span>
            <label class="check"><input type="checkbox" name="autoSearch"${s.autoSearch ? ' checked' : ''} />
              <span><b>Search after a scheduled scan</b><span class="hint">Sonarr’s RSS sync catches new dual audio releases by itself once the custom formats are set up; this also looks for older releases.</span></span></label>
            <div class="row">
              <div class="field"><label for="per-run">Series per run</label><input class="input" id="per-run" name="searchPerRun" type="number" min="1" max="100" value="${esc(s.searchPerRun)}" /></div>
              <div class="field"><label for="again">Search again after (days)</label><input class="input" id="again" name="searchAgainDays" type="number" min="1" max="365" value="${esc(s.searchAgainDays)}" /></div>
            </div>
            <span class="hint">Least recently searched first, so a big library is worked through over a few nights without hammering your indexers.</span>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div><h2>Notifications</h2><p>Hear when files are upgraded to dual audio, or when new ones break the rules.</p></div></div>
          <div class="panel-body">
            <label class="check"><input type="checkbox" name="notifyUpgrades"${s.notifyUpgrades ? ' checked' : ''} /><span><b>Upgrades to dual audio</b></span></label>
            <label class="check"><input type="checkbox" name="notifyProblems"${s.notifyProblems ? ' checked' : ''} /><span><b>New problems, and scheduled scans that fail</b><span class="hint">Files without Japanese audio or without subtitles.</span></span></label>
            <div id="notifiers"></div>
            <div class="row" style="flex:none">
              <select class="select" id="nt-type" style="flex:none;width:180px">${Object.entries(NOTIFIER_TYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
              <button type="button" class="btn btn-sm" id="nt-add" style="flex:none">${icon('plus')}Add</button>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div><h2>Login & API key</h2><p>Signed in as <b>${esc(s.authUser)}</b>.</p></div></div>
          <div class="panel-body">
            <div class="field"><label for="acc-user">Username</label><input class="input" id="acc-user" value="${esc(s.authUser)}" autocomplete="username" /></div>
            <div class="row">
              <div class="field"><label for="acc-new">New password</label><input class="input" id="acc-new" type="password" autocomplete="new-password" placeholder="leave blank to keep" /></div>
              <div class="field"><label for="acc-new2">Confirm</label><input class="input" id="acc-new2" type="password" autocomplete="new-password" /></div>
            </div>
            <div class="field"><label for="acc-cur">Current password</label><input class="input" id="acc-cur" type="password" autocomplete="current-password" placeholder="needed to change either" /></div>
            <div class="row" style="flex:none"><button type="button" class="btn btn-sm" id="acc-save" style="flex:none">Update login</button><span class="hint">Changing the password signs out every other browser.</span></div>
            <div class="field">
              <span class="label">API key <span class="label-note">— for scripts, e.g. <code>curl -X POST -H "X-Api-Key: …" …/api/scan</code></span></span>
              <div class="feed"><code>${esc(s.apiKey)}</code>
                <button type="button" class="btn btn-ghost btn-sm btn-icon" data-copy-text="${esc(s.apiKey)}" title="Copy">${icon('copy')}</button>
                <button type="button" class="btn btn-ghost btn-sm" id="regen-api">New key</button></div>
            </div>
          </div>
        </div>
      </div>
      <div class="save-bar"><button class="btn btn-primary" type="submit">Save settings</button></div>
    </form>`;

  const form = document.getElementById('settings-form');

  // --- Sonarr setup ---
  const setupBody = form.querySelector('#setup-body');
  const renderSetup = (setup) => {
    // Until profiles are chosen, suggest the ones the checked series already use.
    const chosen = new Set(s.profileIds.length ? s.profileIds : setup.profiles.filter((p) => p.series).map((p) => p.id));
    const formatsOk = setup.formats.dual && setup.formats.dub;
    setupBody.innerHTML = `
      <div class="notice${formatsOk ? ' info' : ''}" style="margin:0">${
        formatsOk
          ? `Custom formats <b>Dual Audio (Dualarr)</b> and <b>Dub Only (Dualarr)</b> are in Sonarr.`
          : 'The custom formats aren’t in Sonarr yet — pick profiles and apply.'
      }</div>
      <div class="field">
        <span class="label">Quality profiles <span class="label-note">— the ones your anime uses</span></span>
        <div class="profiles">${setup.profiles
          .map(
            (p) => `<div class="profile">
              <label class="check"><input type="checkbox" data-profile="${p.id}"${chosen.has(p.id) ? ' checked' : ''} />
                <span class="profile-name"><b>${esc(p.name)}</b><span class="hint">${p.series ? plural(p.series, 'checked series', 'checked series') : 'no checked series'}</span>
                ${p.ready ? `<span class="ready">${icon('check')} Ready</span>` : formatsOk && (p.series || chosen.has(p.id)) ? '<span class="not-ready">Needs applying</span>' : ''}</span></label>
              ${p.dual !== null ? `<div class="profile-scores">Dual audio ${p.dual} · dub only ${p.dub ?? 0} · best other format ${p.top} · upgrade until ${p.cutoffFormatScore} · minimum ${p.minFormatScore}${p.upgradeAllowed ? '' : ' · upgrades off'}</div>` : ''}
              ${formatsOk && p.problems.length && (p.series || chosen.has(p.id)) ? `<ul>${p.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
            </div>`,
          )
          .join('')}</div>
      </div>
      <div class="row">
        <div class="field" style="max-width:220px"><label for="dual-score">Dual audio score</label><input class="input" id="dual-score" type="number" min="1" value="${esc(s.dualScore)}" /></div>
        <span class="hint">Must beat every other custom format in the profile, so a dual audio release always wins. Dub-only releases get −10000.</span>
      </div>
      <div class="row" style="flex:none">
        <button type="button" class="btn btn-primary btn-sm" id="setup-apply" style="flex:none">Apply to Sonarr</button>
        <span class="hint">Creates or updates both formats, sets their scores, turns upgrades on and sets “upgrade until” so subbed files keep upgrading until dual audio arrives. Other settings in the profile are left alone.</span>
      </div>`;
  };
  if (sonarrConnected()) {
    api('/api/setup')
      .then(renderSetup)
      .catch((err) => {
        setupBody.innerHTML = `<span class="test-result err">${esc(err.message)}</span>`;
      });
  }

  // --- notifiers ---
  const notifiers = structuredClone(s.notifiers || []);
  const renderNotifiers = () => {
    form.querySelector('#notifiers').innerHTML = notifiers
      .map((n, i) => {
        const t = NOTIFIER_TYPES[n.type];
        return `<div class="notifier" data-i="${i}">
          <div class="row" style="flex:none">
            <b style="flex:none;min-width:90px">${t.label}</b>
            <input class="input" data-nf="name" value="${esc(n.name || '')}" placeholder="Name (optional)" />
            <label class="check" style="flex:none;align-items:center"><input type="checkbox" data-nf="enabled"${n.enabled !== false ? ' checked' : ''} /><span>On</span></label>
          </div>
          ${t.fields
            .map(([k, label, ph, secret]) => `<div class="field"><label>${label}</label><input class="input mono" data-nf="${k}" ${secret ? 'type="password" autocomplete="new-password"' : ''} value="${esc(n[k] || '')}" placeholder="${esc(ph || '')}" /></div>`)
            .join('')}
          <div class="row" style="flex:none">
            <button type="button" class="btn btn-sm" data-ntest="${i}" style="flex:none">Send test</button>
            <span class="test-result" id="nt-res-${i}"></span>
            <button type="button" class="btn btn-sm btn-ghost btn-danger" data-nremove="${i}" style="flex:none;margin-left:auto">Remove</button>
          </div>
        </div>`;
      })
      .join('');
  };
  const readNotifiers = () =>
    [...form.querySelectorAll('.notifier')].map((el) => {
      const n = { ...notifiers[Number(el.dataset.i)] };
      el.querySelectorAll('[data-nf]').forEach((inp) => (n[inp.dataset.nf] = inp.type === 'checkbox' ? inp.checked : inp.value));
      return n;
    });
  renderNotifiers();

  form.querySelector('#sched-preset').addEventListener('change', (e) => {
    const custom = e.target.value === 'custom';
    form.querySelector('#cron-field').classList.toggle('hidden', !custom);
    if (!custom) form.querySelector('#cron').value = e.target.value;
  });

  const collect = () => {
    const fd = new FormData(form);
    return {
      sonarrUrl: fd.get('sonarrUrl'),
      sonarrApiKey: fd.get('sonarrApiKey'),
      scope: fd.get('scope'),
      requireSubtitles: fd.get('requireSubtitles') === 'on',
      subtitleLanguage: fd.get('subtitleLanguage'),
      schedule: fd.get('schedule'),
      autoSearch: fd.get('autoSearch') === 'on',
      searchPerRun: Number(fd.get('searchPerRun')),
      searchAgainDays: Number(fd.get('searchAgainDays')),
      notifyUpgrades: fd.get('notifyUpgrades') === 'on',
      notifyProblems: fd.get('notifyProblems') === 'on',
      notifiers: readNotifiers(),
    };
  };

  const testSonarr = async () => {
    const out = form.querySelector('#sonarr-res');
    out.className = 'test-result';
    out.textContent = 'Testing…';
    const v = collect();
    try {
      const r = await api('/api/settings/test', { method: 'POST', body: { url: v.sonarrUrl, apiKey: v.sonarrApiKey } });
      out.className = `test-result ${r.ok ? 'ok' : 'err'}`;
      out.textContent = r.ok ? `Connected to ${r.appName} ${r.version}` : `Failed: ${r.error}`;
    } catch (err) {
      out.className = 'test-result err';
      out.textContent = err.message;
    }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const wasConnected = sonarrConnected();
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: collect() });
      if (state.settings.rescanning) {
        toast('Settings saved — rescanning with the new rules');
        watchJob();
      } else toast('Settings saved');
      pollStatus();
      // Just connected: straight on to a first scan.
      if (!wasConnected && sonarrConnected() && !state.settings.rescanning) {
        await api('/api/scan', { method: 'POST' }).catch(() => {});
        watchJob();
      }
      viewSettings();
    } catch (err) {
      toast(err.message, true);
    }
  });

  form.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.copyText) return copyText(b.dataset.copyText);
    if (b.id === 'sonarr-test') return testSonarr();
    if (b.id === 'sonarr-forget') {
      state.settings = await api('/api/settings', { method: 'PUT', body: { clearSonarrApiKey: true } });
      toast('API key removed');
      return viewSettings();
    }
    if (b.id === 'setup-apply') {
      const profileIds = [...form.querySelectorAll('[data-profile]:checked')].map((c) => Number(c.dataset.profile));
      if (!profileIds.length) return toast('Pick at least one quality profile', true);
      b.disabled = true;
      b.textContent = 'Applying…';
      try {
        const r = await api('/api/setup', { method: 'POST', body: { profileIds, dualScore: Number(form.querySelector('#dual-score').value) } });
        toast(`Applied to ${r.summary.profiles.join(', ')}${r.summary.warnings.length ? ` — ${r.summary.warnings.join('; ')}` : ''}`, r.status !== 'ok');
        await loadSettings();
        Object.assign(s, { profileIds: state.settings.profileIds, dualScore: state.settings.dualScore });
        renderSetup(r);
      } catch (err) {
        toast(err.message, true);
        b.disabled = false;
        b.textContent = 'Apply to Sonarr';
      }
      return;
    }
    if (b.id === 'regen-api') {
      if (!confirm('Make a new API key? Anything using the old one stops working.')) return;
      state.settings = await api('/api/auth/keys/api', { method: 'POST' });
      toast('New API key created');
      return viewSettings();
    }
    if (b.id === 'acc-save') {
      const v = (id) => form.querySelector(id).value;
      if (v('#acc-new') !== v('#acc-new2')) return toast('The new passwords don’t match', true);
      try {
        await api('/api/auth/account', { method: 'PUT', body: { current: v('#acc-cur'), username: v('#acc-user'), password: v('#acc-new') || undefined } });
        toast('Login updated');
        viewSettings();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    if (b.id === 'nt-add') {
      notifiers.splice(0, notifiers.length, ...readNotifiers());
      notifiers.push({ type: form.querySelector('#nt-type').value, enabled: true });
      renderNotifiers();
      return;
    }
    if (b.dataset.nremove) {
      notifiers.splice(0, notifiers.length, ...readNotifiers());
      notifiers.splice(Number(b.dataset.nremove), 1);
      renderNotifiers();
      return;
    }
    if (b.dataset.ntest) {
      const out = form.querySelector(`#nt-res-${b.dataset.ntest}`);
      out.className = 'test-result';
      out.textContent = 'Sending…';
      try {
        const r = await api('/api/notify/test', { method: 'POST', body: readNotifiers()[Number(b.dataset.ntest)] });
        out.className = `test-result ${r.ok ? 'ok' : 'err'}`;
        out.textContent = r.ok ? 'Sent — check your app' : `Failed: ${r.error}`;
      } catch (err) {
        out.className = 'test-result err';
        out.textContent = err.message;
      }
    }
  });
}

// ---------- activity ----------

async function viewActivity() {
  const runs = await api('/api/runs');
  view.innerHTML = `
    <div class="page-head"><div><h1>Activity</h1><p>Scans, searches, replacements and Sonarr setup.</p></div></div>
    <div class="panel">
      ${
        runs.length
          ? `<table class="table">
              <thead><tr><th style="width:160px">Started</th><th style="width:130px">What</th><th style="width:110px">Result</th><th>Details</th></tr></thead>
              <tbody>${runs.map(runRow).join('')}</tbody>
            </table>`
          : '<div class="panel-body muted">Nothing yet.</div>'
      }
    </div>`;
}

const TRIGGERS = { schedule: 'Scheduled scan', scan: 'Scan', rules: 'Rescan (rules)', search: 'Search', replace: 'Replace', setup: 'Sonarr setup' };
const titles = (list, fmt) => list.map(fmt).join(', ');

function runRow(r) {
  const s = r.summary || {};
  const lines = [];
  if (s.scanned !== undefined) {
    lines.push(`<span>Checked ${plural(s.scanned, 'series', 'series')}</span>`);
    if (s.totals) lines.push(`<div class="vbs">${Object.keys(VERDICTS).filter((k) => s.totals.files[k]).map((k) => verdictBadge(k, s.totals.files[k])).join('')}</div>`);
  }
  if (s.upgraded?.length) lines.push(`<span style="color:var(--ok)">Upgraded to dual audio: ${esc(titles(s.upgraded, (u) => `${u.title} (${u.files})`))}</span>`);
  if (s.problems?.length) {
    lines.push(`<span style="color:var(--warn)">New problems: ${esc(titles(s.problems, (p) => `${p.title} (${[p.noJapanese && `${p.noJapanese} no Japanese`, p.noSubs && `${p.noSubs} no subs`].filter(Boolean).join(', ')})`))}</span>`);
  }
  if (s.searched?.length) lines.push(`<span>Searched: ${esc(titles(s.searched, (x) => x.title))}</span>`);
  else if (s.searched && r.trigger === 'schedule') lines.push('<span class="faint">Nothing due for a search</span>');
  if (s.replaced) lines.push(`<span>${esc(s.replaced.title)}: deleted ${plural(s.replaced.files, 'file')}, blocklisted ${s.replaced.blocklisted}, searching ${plural(s.replaced.episodes, 'episode')}</span>`);
  if (s.profiles?.length) lines.push(`<span>Scores applied to ${esc(s.profiles.join(', '))}</span>`);
  for (const w of s.warnings || []) lines.push(`<span style="color:var(--warn)">${esc(w)}</span>`);
  if (s.error) lines.push(`<span style="color:var(--err)">${esc(s.error)}</span>`);
  if (s.notified) lines.push(`<span class="faint">Sent ${plural(s.notified, 'notification')}</span>`);
  return `<tr>
    <td>${esc(fmtDate(r.started_at))}</td>
    <td class="muted">${esc(TRIGGERS[r.trigger] || r.trigger)}</td>
    <td><span class="st ${esc(r.status)}">${esc(r.status)}</span></td>
    <td><div class="run-lines">${lines.join('') || '<span class="faint">—</span>'}</div></td>
  </tr>`;
}

// ---------- login & first run ----------

/** Full-page screens (login, create account) hide the app's top bar. */
function bare(on) {
  document.body.classList.toggle('bare', on);
}

function authShell(inner) {
  return `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand"><img src="logo.svg" alt="" width="44" height="44" /><span>Dualarr</span></div>
        ${inner}
      </div>
      <p class="auth-foot">Japanese audio with subtitles — and dual audio once the dub is out</p>
    </div>`;
}

function viewLogin(message) {
  bare(true);
  view.innerHTML = authShell(`
    <h1>Log in</h1>
    <form id="login-form" class="auth-form" autocomplete="on">
      <div class="field"><label for="lg-user">Username</label><input class="input" id="lg-user" name="username" autocomplete="username" required autofocus /></div>
      <div class="field"><label for="lg-pass">Password</label><input class="input" id="lg-pass" name="password" type="password" autocomplete="current-password" required /></div>
      <label class="check"><input type="checkbox" name="remember" checked /><span><b>Keep me logged in</b><span class="hint">For 30 days on this browser.</span></span></label>
      <div class="auth-error" id="lg-error">${esc(message || '')}</div>
      <button class="btn btn-primary auth-submit" type="submit">Log in</button>
      <p class="hint">Forgot it? Restart the container once with <code>DUALARR_RESET_AUTH=true</code> to set a new login.</p>
    </form>`);
  const form = view.querySelector('#login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/api/auth/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password'), remember: fd.get('remember') === 'on' } });
      await startApp();
    } catch (err) {
      form.querySelector('#lg-error').textContent = err.message;
      btn.disabled = false;
    }
  });
}

function viewCreateAccount() {
  bare(true);
  view.innerHTML = authShell(`
    <h1>Welcome to Dualarr</h1>
    <p class="muted">First, create the login for this Dualarr. Anyone who can reach it on your network will need it.</p>
    <form id="acct-form" class="auth-form" autocomplete="on">
      <div class="field"><label for="ac-user">Username</label><input class="input" id="ac-user" name="username" autocomplete="username" required minlength="2" maxlength="40" autofocus /></div>
      <div class="field"><label for="ac-pass">Password</label><input class="input" id="ac-pass" name="password" type="password" autocomplete="new-password" required minlength="8" />
        <span class="hint">At least 8 characters.</span></div>
      <div class="field"><label for="ac-pass2">Confirm password</label><input class="input" id="ac-pass2" name="password2" type="password" autocomplete="new-password" required minlength="8" /></div>
      <div class="auth-error" id="ac-error"></div>
      <button class="btn btn-primary auth-submit" type="submit">Create account</button>
    </form>`);
  const form = view.querySelector('#acct-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const err = form.querySelector('#ac-error');
    if (fd.get('password') !== fd.get('password2')) {
      err.textContent = 'The passwords don’t match';
      return;
    }
    try {
      await api('/api/auth/setup', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
      await startApp();
    } catch (e2) {
      err.textContent = e2.message;
    }
  });
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  clearTimeout(pollTimer);
  state.settings = null;
  document.getElementById('logout').hidden = true;
  // replaceState: changing the hash directly would trigger a route to the (now locked) library.
  history.replaceState(null, '', '#/');
  viewLogin('You have been logged out.');
}

/** Called once the browser is logged in: loads settings and shows the app. */
async function startApp() {
  bare(false);
  await loadSettings();
  document.getElementById('logout').hidden = false;
  pollStatus();
  // Nothing to show until Sonarr is connected.
  if (!sonarrConnected() && !/^#\/(settings|activity)/.test(location.hash)) location.hash = '#/settings';
  else route();
}

async function boot() {
  let st;
  try {
    const res = await fetch('/api/auth/status');
    if (checkBuild(res)) return;
    st = await res.json();
  } catch {
    view.innerHTML = '<div class="empty"><h2>Can’t reach Dualarr</h2><p>Is the container running?</p></div>';
    return;
  }
  if (!st.configured) return viewCreateAccount();
  if (!st.authenticated) return viewLogin();
  await startApp();
}

// ---------- boot ----------

document.getElementById('logout').addEventListener('click', logout);
boot();
