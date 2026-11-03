// Dashboard page. Everything goes through textContent and setAttribute, so no fetched string is ever parsed as HTML.
// The stats key lives only in the `key` variable below: it isn't put in the URL or in any storage.
import {
  channelName, describeError, fetchReleases, fetchStats, fmtDay, fmtNumber, fmtShare, fmtTime, niceTicks,
  summarizeDownloads, topWithOther,
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
  parts.push(el('dl', { class: 'tiles tiles-three' },
    tile('Launches, last 30 days', fmtNumber(s.launches30d), `${fmtNumber(s.launchesEver)} since ${fmtDay(s.firstDay)}`),
    tile('Active today', fmtNumber(s.activeToday), `Installs started on ${fmtDay(s.today, false)} so far`),
    tile('Active, last 7 days', fmtNumber(s.activeWeek), 'Installs, each counted once'),
    tile('Active, last 30 days', fmtNumber(s.activeMonth), 'Installs, each counted once'),
    tile('Installs seen', fmtNumber(s.installsEver), `All time, since ${fmtDay(s.firstDay)}`),
    tile('Auto updates, last 30 days', fmtNumber(s.autoupdates30d), `${fmtNumber(s.autoupdatesEver)} all time`),
  ));

  const launches = chartCard('Launches per day', s.days, d => d.launches, 'launch', 'launches');
  const active = chartCard('Active installs per day', s.days, d => d.installs, 'active install', 'active installs');
  parts.push(el('div', { class: 'charts' }, launches.card, active.card));

  const rows = [...s.days].reverse().map(d => el('tr', {},
    el('th', { scope: 'row' }, fmtDay(d.day) + (d.partial ? ' (so far)' : '')),
    el('td', {}, fmtNumber(d.launches)),
    el('td', {}, fmtNumber(d.installs)),
    el('td', {}, fmtNumber(d.publicLaunches)),
    el('td', {}, fmtNumber(d.experimentalLaunches))));
  parts.push(el('details', { class: 'daily' },
    el('summary', {}, 'Daily numbers as a table'),
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

  charts = [launches, active];
  for (const c of charts) c.draw();
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

// One bar chart: a single series on one axis. Pointer or arrow keys pick a day; the line above the chart reads it out.
function chartCard(title, days, value, one, many) {
  const readout = el('p', { class: 'readout' });
  const figure = svg('svg', {
    class: 'chart', role: 'slider', tabindex: '0', 'aria-label': `${title}. Arrow keys move between days.`,
    'aria-orientation': 'horizontal', 'aria-valuemin': '0', 'aria-valuemax': String(days.length - 1),
  });
  const box = el('div', { class: 'chart-box' }, figure);
  const card = el('div', { class: 'chart-card' }, el('h3', {}, title), readout, box);
  let selected = days.length - 1;
  let bands = [];
  let slot = 1;
  let left = 0;

  const text = i => {
    const d = days[i];
    const date = fmtDay(d.day);
    const unit = value(d) === 1 ? one : many;
    return { date: d.partial ? `${date}, so far` : date, amount: `${fmtNumber(value(d))} ${unit}` };
  };

  function select(i) {
    selected = Math.max(0, Math.min(days.length - 1, i));
    bands.forEach((b, n) => b.setAttribute('class', n === selected ? 'band on' : 'band'));
    const t = text(selected);
    readout.replaceChildren(`${t.date}: `, el('strong', {}, t.amount));
    figure.setAttribute('aria-valuenow', String(selected));
    figure.setAttribute('aria-valuetext', `${t.date}: ${t.amount}`);
  }

  function draw() {
    const width = Math.max(box.clientWidth, 240);
    const height = 220;
    const top = 8;
    const bottom = 26;
    const plot = height - top - bottom;
    const ticks = niceTicks(Math.max(...days.map(value)));
    const max = ticks[ticks.length - 1];
    const y = v => top + plot - (v / max) * plot;
    left = 8 + String(fmtNumber(max)).length * 8;
    const right = 4;
    slot = (width - left - right) / days.length;
    figure.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const nodes = [];
    for (const t of ticks) {
      nodes.push(svg('line', { class: 'grid-line', x1: left, x2: width - right, y1: y(t), y2: y(t) }));
      const label = svg('text', { class: 'axis-text', x: left - 8, y: y(t) + 4, 'text-anchor': 'end' });
      label.textContent = fmtNumber(t);
      nodes.push(label);
    }
    bands = days.map((d, i) => {
      const bandWidth = Math.min(slot, 44);
      const band = svg('rect', { class: 'band', x: left + i * slot + (slot - bandWidth) / 2, y: top, width: bandWidth, height: plot, rx: 2 });
      nodes.push(band);
      return band;
    });
    const barWidth = Math.max(2, Math.min(24, slot - 2));
    days.forEach((d, i) => {
      const v = value(d);
      if (v > 0) {
        const x = left + i * slot + (slot - barWidth) / 2;
        const h = Math.max(2, plot + top - y(v));
        const r = Math.min(4, barWidth / 2, h);
        const base = top + plot;
        nodes.push(svg('path', {
          class: d.partial ? 'bar partial' : 'bar',
          d: `M${x} ${base}V${base - h + r}Q${x} ${base - h} ${x + r} ${base - h}H${x + barWidth - r}Q${x + barWidth} ${base - h} ${x + barWidth} ${base - h + r}V${base}Z`,
        }));
      }
    });
    // Date labels: never more than fit side by side, counted back from the newest day so today always has one.
    const every = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor((width - left) / 62))));
    for (let i = days.length - 1; i >= 0; i -= every) {
      const center = left + i * slot + slot / 2;
      const anchor = center > width - 26 ? 'end' : center < left + 20 ? 'start' : 'middle';
      const label = svg('text', {
        class: 'axis-text', y: height - 7, 'text-anchor': anchor,
        x: anchor === 'end' ? width - right : anchor === 'start' ? left : center,
      });
      label.textContent = fmtDay(days[i].day, false);
      nodes.push(label);
    }
    figure.replaceChildren(...nodes);
    select(selected);
  }

  figure.addEventListener('pointermove', e => {
    const rect = figure.getBoundingClientRect();
    const scale = rect.width ? Number(figure.viewBox.baseVal.width) / rect.width : 1;
    select(Math.floor(((e.clientX - rect.left) * scale - left) / slot));
  });
  figure.addEventListener('pointerleave', () => { if (document.activeElement !== figure) select(days.length - 1); });
  figure.addEventListener('keydown', e => {
    const moves = { ArrowLeft: selected - 1, ArrowDown: selected - 1, ArrowRight: selected + 1, ArrowUp: selected + 1, Home: 0, End: days.length - 1 };
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
