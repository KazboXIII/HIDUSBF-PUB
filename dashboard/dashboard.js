// Dashboard page. Everything goes through textContent and setAttribute, so no fetched string is ever parsed as HTML.
// The stats key lives only in the `key` variable below: it isn't put in the URL or in any storage.
import {
  RANGES, channelName, describeError, fetchReleases, fetchSeries, fetchStats, fmtBucket, fmtDay, fmtNumber, fmtShare, fmtTime,
  niceTicks, summarizeDownloads, topWithOther,
} from './metrics.js';

const $ = id => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter(c => c !== null && c !== undefined));
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const plural = (n, one, many = `${one}s`) => `${fmtNumber(n)} ${n === 1 ? one : many}`;

function tile(label, value, note) {
  return el('div', { class: 'tile' }, el('dt', {}, label), el('dd', {},
    el('span', { class: 'value' }, value),
    note ? el('span', { class: 'note' }, note) : null));
}

function errorBox(message, retry, label = 'Try again') {
  const button = el('button', { class: 'button', type: 'button' }, label);
  button.addEventListener('click', retry);
  return el('div', { class: 'state error', role: 'alert' }, el('p', {}, message), button);
}

// ---- status line and refresh ----

const updated = { downloads: null, usage: null };
let busy = 0;

function showStatus() {
  const parts = [];
  if (busy > 0) parts.push('Refreshing…');
  else {
    if (updated.usage) parts.push(`Usage ${fmtTime(updated.usage)}`);
    if (updated.downloads) parts.push(`Downloads ${fmtTime(updated.downloads)}`);
  }
  $('status').textContent = busy > 0 || !parts.length ? parts.join('') : `Updated: ${parts.join(' · ')}`;
  const refresh = $('refresh');
  refresh.disabled = busy > 0;
  refresh.textContent = busy > 0 ? 'Refreshing…' : 'Refresh';
}

async function track(work) {
  busy++;
  showStatus();
  try { await work(); } finally { busy--; showStatus(); }
}

// ---- downloads (public) ----

let lastDownloads = null;

function renderDownloads(data, staleMessage) {
  const box = $('downloads');
  const parts = [];
  if (staleMessage) parts.push(errorBox(staleMessage, loadDownloads));
  if (!data.rows.length) {
    parts.push(el('p', { class: 'state' }, 'No published releases yet, so there are no downloads to show.'));
    box.replaceChildren(...parts);
    return;
  }
  const { totals, byChannel, latest } = data;
  const experimental = byChannel.experimental;
  parts.push(el('dl', { class: 'tiles' },
    tile('Installer downloads', fmtNumber(totals.installer), `Across ${plural(totals.releases, 'release')}, all time`),
    tile('Checksum downloads', fmtNumber(totals.checksum), 'The .sha256 files, counted apart'),
    latest
      ? tile('Latest public release', latest.tag, `${plural(latest.installer, 'installer download')} · ${fmtDay(latest.published)}`)
      : tile('Latest public release', '—', 'None published'),
    experimental.releases
      ? tile('Experimental downloads', fmtNumber(experimental.installer), `Installers, ${plural(experimental.releases, 'release')} in the public repository`)
      : tile('Experimental downloads', '—', 'Not readable: those builds are in a private repository'),
  ));

  parts.push(el('h3', { class: 'subhead' }, 'By release'));
  parts.push(el('p', { class: 'subnote' }, 'Newest first. Bars show installer downloads against the most-downloaded release.'));
  const body = data.rows.map(row => el('tr', {},
    el('th', { scope: 'row' }, row.url ? el('a', { href: row.url, rel: 'noreferrer' }, row.tag) : row.tag),
    el('td', { class: 'left channel-col' }, channelName(row.channel)),
    el('td', { class: 'left' }, fmtDay(row.published)),
    el('td', { class: 'installer-cell' }, cellBar(row.installer, data.topInstaller)),
    el('td', {}, fmtNumber(row.checksum)),
  ));
  parts.push(el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Downloads by release' },
    el('table', { class: experimental.releases ? 'dash-table' : 'dash-table one-channel' },
      el('caption', { class: 'visually-hidden' }, 'Lifetime downloads per release, from GitHub'),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Release'),
        el('th', { scope: 'col', class: 'left channel-col' }, 'Channel'),
        el('th', { scope: 'col', class: 'left' }, 'Published'),
        el('th', { scope: 'col' }, 'Installer'),
        el('th', { scope: 'col' }, 'Checksum'))),
      el('tbody', {}, body),
      el('tfoot', {}, el('tr', {},
        el('th', { scope: 'row' }, 'Total'),
        el('td', { class: 'channel-col' }), el('td', {}),
        el('td', {}, fmtNumber(totals.installer)),
        el('td', {}, fmtNumber(totals.checksum)))))));
  box.replaceChildren(...parts);
}

function cellBar(value, top) {
  const fill = el('span', { class: 'fill' });
  fill.style.setProperty('width', `${top ? (value / top) * 100 : 0}%`);
  if (!value) fill.hidden = true;
  return el('div', { class: 'cell-bar' }, el('span', { class: 'track', 'aria-hidden': 'true' }, fill), el('span', { class: 'n' }, fmtNumber(value)));
}

function loadDownloads() {
  return track(async () => {
    try {
      lastDownloads = summarizeDownloads(await fetchReleases());
      updated.downloads = new Date().toISOString();
      renderDownloads(lastDownloads);
    } catch (e) {
      const message = describeError(e, 'downloads');
      if (lastDownloads) renderDownloads(lastDownloads, `${message} Showing the numbers from ${fmtTime(updated.downloads)}.`);
      else $('downloads').replaceChildren(errorBox(message, loadDownloads));
    }
  });
}

// ---- usage (needs the key) ----

let key = null;
let lastUsage = null;
let usageRun = 0;          // A response from before a Lock is dropped.
let charts = [];

function lock(message = '') {
  key = null;
  usageRun++;
  seriesRun++;
  lastSeries = null;
  lastUsage = null;
  updated.usage = null;
  charts = [];
  $('usage').replaceChildren();
  $('usage').hidden = true;
  $('lock').hidden = true;
  $('unlock-form').hidden = false;
  $('unlock-error').textContent = message;
  $('unlock-button').disabled = false;
  $('unlock-button').textContent = 'Unlock';
  showStatus();
}

async function loadUsage() {
  if (!key) return;
  const run = ++usageRun;
  await track(async () => {
    try {
      const stats = await fetchStats(key);
      if (run !== usageRun) return;
      lastUsage = stats;
      updated.usage = stats.generated || new Date().toISOString();
      $('stats-key').value = '';
      $('unlock-error').textContent = '';
      $('unlock-form').hidden = true;
      $('usage').hidden = false;
      $('lock').hidden = false;
      const unlocking = $('usage').childElementCount === 0;
      renderUsage(stats);
      // The form that held focus just vanished: carry focus to the section, so keyboard users don't restart from the top.
      if (unlocking) $('usage-title').focus({ preventScroll: true });
    } catch (e) {
      if (run !== usageRun) return;
      const message = describeError(e, 'usage');
      if (e.kind === 'key') {
        lock(message);
        $('stats-key').value = '';
        $('stats-key').focus();
      } else if (lastUsage) {
        renderUsage(lastUsage, `${message} Showing the numbers from ${fmtTime(updated.usage)}.`);
      } else {
        key = null;
        $('unlock-error').textContent = message;
      }
    }
    $('unlock-button').disabled = false;
    $('unlock-button').textContent = 'Unlock';
  });
}

function renderUsage(s, staleMessage) {
  const parts = [];
  if (staleMessage) parts.push(errorBox(staleMessage, loadUsage));
  charts = [];
  if (s.empty) {
    parts.push(el('p', { class: 'state' }, 'The counter is working, but no launches have been counted yet.'));
    $('usage').replaceChildren(...parts);
    return;
  }
  const openNote = s.openNow === null
    ? 'Not counted by this version of the counter'
    : `${fmtNumber(s.openPublic)} public · ${fmtNumber(s.openExperimental)} experimental, heard from in the last 20 minutes`;
  parts.push(el('dl', { class: 'tiles' },
    tile('Open right now', fmtNumber(s.openNow), openNote),
    tile('Launches, last 30 days', fmtNumber(s.launches30d), `${fmtNumber(s.launchesEver)} since ${fmtDay(s.firstDay)}`),
    tile('Active today', fmtNumber(s.activeToday), `Installs started or open on ${fmtDay(s.today, false)} so far`),
    tile('Active, last 7 days', fmtNumber(s.activeWeek), 'Installs, each counted once'),
    tile('Active, last 30 days', fmtNumber(s.activeMonth), 'Installs, each counted once'),
    tile('Installs seen', fmtNumber(s.installsEver), `All time, since ${fmtDay(s.firstDay)}`),
    tile('Uninstalls, last 30 days', fmtNumber(s.uninstalls30d), `${fmtNumber(s.uninstallsEver)} since counting began`),
    tile('Auto updates, last 30 days', fmtNumber(s.autoupdates30d), `${fmtNumber(s.autoupdatesEver)} all time`),
  ));

  parts.push(rangeBar());
  const seriesBox = el('div', { id: 'series', 'aria-live': 'polite' });
  if (lastSeries && lastSeries.range === range) seriesBox.append(el('p', { class: 'state' }, 'Updating the charts…'));
  else seriesBox.append(el('p', { class: 'state', role: 'status' }, 'Loading the charts…'));
  parts.push(seriesBox);

  const rows = [...s.days].reverse().map(d => el('tr', {},
    el('th', { scope: 'row' }, fmtDay(d.day) + (d.partial ? ' (so far)' : '')),
    el('td', {}, fmtNumber(d.launches)),
    el('td', {}, fmtNumber(d.installs)),
    el('td', {}, fmtNumber(d.publicLaunches)),
    el('td', {}, fmtNumber(d.experimentalLaunches))));
  parts.push(el('details', { class: 'daily' },
    el('summary', {}, 'Daily numbers as a table, last 30 days'),
    el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Daily numbers' },
      el('table', { class: 'dash-table' },
        el('caption', { class: 'visually-hidden' }, 'Launches and active installs per UTC day, newest first'),
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col' }, 'Date (UTC)'),
          el('th', { scope: 'col' }, 'Launches'),
          el('th', { scope: 'col' }, 'Active installs'),
          el('th', { scope: 'col' }, 'Public launches'),
          el('th', { scope: 'col' }, 'Experimental launches'))),
        el('tbody', {}, rows)))));

  parts.push(el('h3', { class: 'subhead' }, 'Installs by version, channel, Windows and language'));
  parts.push(el('p', { class: 'subnote' }, `Last 30 days. Each install counts once, under its most recent start.`));
  parts.push(el('div', { class: 'breakdowns' },
    breakdownCard('Version', s.versions, 'breakdown-tall'),
    breakdownCard('Channel', s.channels),
    breakdownCard('Windows build', s.os),
    breakdownCard('Language', s.langs)));
  $('usage').replaceChildren(...parts);
  if (lastSeries && lastSeries.range === range) renderSeries(lastSeries);
  loadSeries();
}

function breakdownCard(title, rows, extra = '') {
  const cls = `breakdown ${extra}`.trim();
  if (!rows.length) return el('div', { class: cls }, el('h4', {}, title), el('p', { class: 'subnote' }, 'Nothing in the last 30 days.'));
  return el('div', { class: cls }, el('h4', {}, title), el('ul', {}, topWithOther(rows).map(row => {
    const fill = el('div', { class: 'bar-fill' });
    fill.style.setProperty('width', `${row.width * 100}%`);
    return el('li', {},
      el('div', { class: 'row' },
        el('span', { class: 'name' }, row.label),
        el('span', { class: 'amount' }, `${fmtNumber(row.installs)} `, el('small', {}, fmtShare(row.share)))),
      el('div', { class: 'bar-track', 'aria-hidden': 'true' }, fill));
  })));
}

// ---- lines over a chosen range ----

let range = '1d';
let lastSeries = null;
let seriesRun = 0;

const SERIES = [
  { key: 'public', name: 'Public', cls: 's-public' },
  { key: 'experimental', name: 'Experimental', cls: 's-exp' },
];

// One row of buttons above the charts. The choice lives only in this tab's memory.
function rangeBar() {
  const buttons = RANGES.map(r => {
    const b = el('button', { class: 'range', type: 'button', 'aria-pressed': r.key === range ? 'true' : 'false' }, r.label);
    b.addEventListener('click', () => {
      if (range === r.key) return;
      range = r.key;
      for (const x of buttons) x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      loadSeries();
    });
    return b;
  });
  return el('div', { class: 'range-bar', role: 'group', 'aria-label': 'Time range for the charts' },
    el('span', { class: 'range-label' }, 'Show the last'), buttons);
}

async function loadSeries() {
  if (!key) return;
  const run = ++seriesRun;
  const want = range;
  const busyBox = $('series');
  if (busyBox) busyBox.setAttribute('aria-busy', 'true');
  await track(async () => {
    try {
      const data = await fetchSeries(key, want);
      if (run !== seriesRun) return;
      lastSeries = { ...data, range: want };
      renderSeries(lastSeries);
    } catch (e) {
      if (run !== seriesRun) return;
      const message = describeError(e, 'usage');
      if (e.kind === 'key') { lock(message); return; }
      const box = $('series');
      if (box) box.replaceChildren(errorBox(`${message} The charts couldn’t load.`, loadSeries));
    } finally {
      const box = $('series');
      if (box) box.removeAttribute('aria-busy');
    }
  });
}

const sumOf = values => {
  const known = values.filter(v => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};

function renderSeries(data) {
  const box = $('series');
  if (!box) return;
  const per = data.step >= 86400 ? 'day' : data.step >= 3600 ? 'hour' : '15 minutes';
  const cards = [
    lineCard('Apps open', data.step > 900 ? `The most open at the same time in each ${per}.` : 'How many were open at each 15-minute check.',
      data, p => p.open, 'install open', 'installs open'),
    lineCard('Launches', `Starts per ${per}.`, data, p => p.launches, 'launch', 'launches'),
    lineCard('Uninstalls', `Per ${per}. Counted by builds from exp.48 on.`, data, p => p.uninstalls, 'uninstall', 'uninstalls'),
  ];
  if (data.daily) cards.push(lineCard('Active installs', 'Installs that started or were open that day, each once.', data, p => p.installs, 'active install', 'active installs'));

  const parts = [];
  if (data.trackingSince === null) parts.push(el('p', { class: 'subnote' }, 'Open counts and uninstalls begin with the first 15-minute check after the counter update.'));
  else if (data.trackingSince > data.from) parts.push(el('p', { class: 'subnote' }, `Open counts and uninstalls begin ${fmtBucket(data.trackingSince, 900)} UTC; earlier points are empty, not zero.`));
  parts.push(el('div', { class: 'charts' }, cards.map(c => c.card)));

  const rows = [...data.points].reverse().map(p => el('tr', {},
    el('th', { scope: 'row' }, fmtBucket(p.t, data.step) + (p.partial ? ' (so far)' : '')),
    el('td', {}, fmtNumber(p.open.public)),
    el('td', {}, fmtNumber(p.open.experimental)),
    el('td', {}, fmtNumber(sumOf(SERIES.map(s => p.launches[s.key])))),
    el('td', {}, fmtNumber(sumOf(SERIES.map(s => p.uninstalls[s.key]))))));
  parts.push(el('details', { class: 'daily' },
    el('summary', {}, 'These charts as a table'),
    el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Chart numbers' },
      el('table', { class: 'dash-table' },
        el('caption', { class: 'visually-hidden' }, 'Open installs, launches and uninstalls for the chosen range, newest first, UTC'),
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col' }, data.step >= 86400 ? 'Date (UTC)' : 'Time (UTC)'),
          el('th', { scope: 'col' }, 'Open, public'),
          el('th', { scope: 'col' }, 'Open, experimental'),
          el('th', { scope: 'col' }, 'Launches'),
          el('th', { scope: 'col' }, 'Uninstalls'))),
        el('tbody', {}, rows)))));
  box.replaceChildren(...parts);
  charts = cards;
  for (const c of charts) c.draw();
}

// One line chart: public and experimental on one axis. Pointer or arrow keys pick a point; the line above the chart reads it out.
// A point with no data is a gap in the line, never a zero.
function lineCard(title, note, data, pick, one, many) {
  const points = data.points;
  const n = points.length;
  const readout = el('p', { class: 'readout' });
  const legend = el('ul', { class: 'legend', 'aria-label': 'Lines' }, SERIES.map(s =>
    el('li', {}, el('span', { class: `swatch ${s.cls}`, 'aria-hidden': 'true' }), s.name)));
  const figure = svg('svg', {
    class: 'chart', role: 'slider', tabindex: '0', 'aria-label': `${title}. Arrow keys move between points.`,
    'aria-orientation': 'horizontal', 'aria-valuemin': '0', 'aria-valuemax': String(Math.max(0, n - 1)),
  });
  const box = el('div', { class: 'chart-box' }, figure);
  const card = el('div', { class: 'chart-card' }, el('h3', {}, title), el('p', { class: 'chart-note' }, note), legend, readout, box);
  const known = i => SERIES.some(s => pick(points[i])[s.key] !== null);
  let latest = n - 1;
  while (latest > 0 && !known(latest)) latest--;
  if (!known(latest)) latest = n - 1;
  let selected = latest;
  let xAt = () => 0;
  let yAt = () => 0;
  let cross = null;
  let dots = [];

  const words = i => {
    const p = points[i];
    const values = pick(p);
    const when = fmtBucket(p.t, data.step) + (data.step >= 86400 ? '' : ' UTC') + (p.partial ? ', so far' : '');
    const total = sumOf(SERIES.map(s => values[s.key]));
    const split = SERIES.map(s => `${s.name} ${values[s.key] === null ? 'no data' : fmtNumber(values[s.key])}`).join(' · ');
    const amount = total === null ? 'no data' : `${fmtNumber(total)} ${total === 1 ? one : many}`;
    return { when, amount, split };
  };

  function select(i) {
    if (!n) return;
    selected = Math.max(0, Math.min(n - 1, i));
    const t = words(selected);
    readout.replaceChildren(`${t.when}: `, el('strong', {}, t.amount), ` (${t.split})`);
    figure.setAttribute('aria-valuenow', String(selected));
    figure.setAttribute('aria-valuetext', `${t.when}: ${t.amount}, ${t.split}`);
    if (cross) {
      const x = xAt(selected);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x);
      dots.forEach((dot, k) => {
        const v = pick(points[selected])[SERIES[k].key];
        if (v === null) { dot.setAttribute('visibility', 'hidden'); return; }
        dot.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', x); dot.setAttribute('cy', yAt(v));
      });
    }
  }

  function draw() {
    const width = Math.max(box.clientWidth, 240);
    const height = 220;
    const top = 10;
    const bottom = 26;
    const plot = height - top - bottom;
    let max = 0;
    for (const p of points) for (const s of SERIES) { const v = pick(p)[s.key]; if (v !== null && v > max) max = v; }
    const ticks = niceTicks(max);
    const top_ = ticks[ticks.length - 1];
    yAt = v => top + plot - (v / top_) * plot;
    const left = 10 + String(fmtNumber(top_)).length * 8;
    const right = 10;
    const span = width - left - right;
    xAt = i => left + (n < 2 ? span / 2 : (i * span) / (n - 1));
    figure.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const nodes = [];
    for (const t of ticks) {
      nodes.push(svg('line', { class: 'grid-line', x1: left, x2: width - right, y1: yAt(t), y2: yAt(t) }));
      const label = svg('text', { class: 'axis-text', x: left - 8, y: yAt(t) + 4, 'text-anchor': 'end' });
      label.textContent = fmtNumber(t);
      nodes.push(label);
    }
    let any = false;
    for (const s of SERIES) {
      let d = '';
      let down = false;
      for (let i = 0; i < n; i++) {
        const v = pick(points[i])[s.key];
        if (v === null) { down = false; continue; }
        any = true;
        d += `${down ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`;
        const before = i > 0 ? pick(points[i - 1])[s.key] : null;
        const after = i < n - 1 ? pick(points[i + 1])[s.key] : null;
        if (before === null && after === null) nodes.push(svg('circle', { class: `solo ${s.cls}`, cx: xAt(i), cy: yAt(v), r: 3 }));
        down = true;
      }
      if (d) nodes.push(svg('path', { class: `line ${s.cls}`, d }));
    }
    if (!any) {
      const empty = svg('text', { class: 'no-data', x: left + span / 2, y: top + plot / 2, 'text-anchor': 'middle' });
      empty.textContent = 'No data in this range yet';
      nodes.push(empty);
    }
    cross = svg('line', { class: 'crosshair', x1: 0, x2: 0, y1: top, y2: top + plot });
    nodes.push(cross);
    dots = SERIES.map(s => { const c = svg('circle', { class: `dot ${s.cls}`, r: 4, visibility: 'hidden' }); nodes.push(c); return c; });
    // Time labels: never more than fit side by side, counted back from the newest point so it always has one.
    const fit = Math.max(1, Math.floor(span / (data.step >= 86400 || data.range === '1h' || data.range === '4h' ? 60 : 110)));
    const every = Math.max(1, Math.ceil(n / fit));
    for (let i = n - 1; i >= 0; i -= every) {
      const center = xAt(i);
      const anchor = center > width - 40 ? 'end' : center < left + 30 ? 'start' : 'middle';
      const label = svg('text', {
        class: 'axis-text', y: height - 7, 'text-anchor': anchor,
        x: anchor === 'end' ? width - right : anchor === 'start' ? left : center,
      });
      label.textContent = fmtBucket(points[i].t, data.step, data.range !== '1h' && data.range !== '4h' && data.range !== '8h' && data.range !== '1d');
      nodes.push(label);
    }
    figure.replaceChildren(...nodes);
    select(selected);
  }

  figure.addEventListener('pointermove', e => {
    const rect = figure.getBoundingClientRect();
    const scale = rect.width ? Number(figure.viewBox.baseVal.width) / rect.width : 1;
    const x = (e.clientX - rect.left) * scale;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(xAt(i) - x) < Math.abs(xAt(best) - x)) best = i;
    select(best);
  });
  figure.addEventListener('pointerleave', () => { if (document.activeElement !== figure) select(latest); });
  figure.addEventListener('keydown', e => {
    const moves = { ArrowLeft: selected - 1, ArrowDown: selected - 1, ArrowRight: selected + 1, ArrowUp: selected + 1, Home: 0, End: n - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    select(moves[e.key]);
  });

  return { card, draw };
}

// ---- wiring ----

$('unlock-form').addEventListener('submit', e => {
  e.preventDefault();
  const typed = $('stats-key').value.trim();
  if (!typed) return;
  key = typed;
  $('unlock-error').textContent = '';
  $('unlock-button').disabled = true;
  $('unlock-button').textContent = 'Checking…';
  loadUsage();
});

$('lock').addEventListener('click', () => { lock(); $('stats-key').focus(); });
$('refresh').addEventListener('click', () => { loadDownloads(); loadUsage(); });
// Forget the key when leaving, so the back button can't bring an unlocked page back from the browser's cache.
window.addEventListener('pagehide', () => { lock(); $('stats-key').value = ''; });

let resizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => { for (const c of charts) c.draw(); });
}).observe($('usage'));

loadDownloads();
