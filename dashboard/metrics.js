// Dashboard data: fetching and adding up, no page code, so tests/dashboard.test.js can run it directly.

export const RELEASES_URL = 'https://api.github.com/repos/KazboXIII/HIDUSBF-PUB/releases';
export const STATS_URL = 'https://hidusbf-ping.kronussells.workers.dev/stats';
const PER_PAGE = 100;
const MAX_PAGES = 20;
const MAX_DAYS = 30;

// kind: network | rate | http | shape | key | server
export class LoadError extends Error {
  constructor(kind, message, resetAt = null) {
    super(message);
    this.name = 'LoadError';
    this.kind = kind;
    this.resetAt = resetAt;
  }
}

// ---- GitHub releases ----

// Every release of the public repo, page by page. One failed page fails the whole load, because partial totals would
// look like real ones.
export async function fetchReleases(fetchFn = fetch) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let response;
    try {
      response = await fetchFn(`${RELEASES_URL}?per_page=${PER_PAGE}&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (e) {
      throw new LoadError('network', 'network failure');
    }
    if (!response.ok) throw releasesHttpError(response);
    let items;
    try { items = await response.json(); } catch (e) { throw new LoadError('shape', 'not JSON'); }
    if (!Array.isArray(items)) throw new LoadError('shape', 'not a list');
    all.push(...items);
    if (items.length < PER_PAGE) return all;
  }
  throw new LoadError('shape', 'too many pages');
}

function releasesHttpError(response) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const retryAfter = Number(response.headers.get('retry-after'));
  const limited = response.status === 429 || (response.status === 403 && (remaining === '0' || retryAfter > 0));
  if (!limited) return new LoadError('http', `HTTP ${response.status}`);
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  let resetAt = null;
  if (reset > 0) resetAt = new Date(reset * 1000).toISOString();
  else if (retryAfter > 0) resetAt = new Date(Date.now() + retryAfter * 1000).toISOString();
  return new LoadError('rate', 'rate limited', resetAt);
}

export function assetKind(name) {
  if (/\.sha256(sum)?$/i.test(name)) return 'checksum';
  if (/\.exe$/i.test(name)) return 'installer';
  return 'other';
}

export function releaseChannel(release) {
  return release.prerelease === true || /-exp\.\d+$/i.test(release.tag_name || '') ? 'experimental' : 'public';
}

// Drafts are left out. Installer and checksum downloads stay separate: everyone who checks a download fetches both.
export function summarizeDownloads(releases) {
  const blank = () => ({ installer: 0, checksum: 0, other: 0, releases: 0 });
  const totals = blank();
  const byChannel = { public: blank(), experimental: blank() };
  const rows = [];
  for (const release of releases) {
    if (!release || release.draft === true) continue;
    const row = {
      tag: String(release.tag_name || 'untagged'),
      url: typeof release.html_url === 'string' ? release.html_url : null,
      channel: releaseChannel(release),
      published: release.published_at || null,
      installer: 0, checksum: 0, other: 0,
    };
    for (const asset of Array.isArray(release.assets) ? release.assets : []) {
      const count = Number(asset && asset.download_count);
      if (Number.isFinite(count) && count > 0) row[assetKind(String(asset.name || ''))] += count;
    }
    for (const bucket of [totals, byChannel[row.channel]]) {
      bucket.installer += row.installer;
      bucket.checksum += row.checksum;
      bucket.other += row.other;
      bucket.releases += 1;
    }
    rows.push(row);
  }
  rows.sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
  const latest = rows.find(r => r.channel === 'public') || null;
  const topInstaller = rows.reduce((max, r) => Math.max(max, r.installer), 0);
  return { rows, totals, byChannel, latest, topInstaller };
}

// ---- private usage stats ----

// The key goes in a header and nowhere else: never the URL, never storage.
export async function fetchStats(key, fetchFn = fetch) {
  let response;
  try {
    response = await fetchFn(STATS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch (e) {
    throw new LoadError('network', 'network failure');
  }
  // The Worker answers a wrong key with the same 404 as an unknown path, on purpose.
  if (response.status === 401 || response.status === 403 || response.status === 404) throw new LoadError('key', 'key refused');
  if (!response.ok) throw new LoadError('server', `HTTP ${response.status}`);
  let raw;
  try { raw = await response.json(); } catch (e) { throw new LoadError('shape', 'not JSON'); }
  return normalizeStats(raw);
}

const count = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const list = v => (Array.isArray(v) ? v : []);

function nextDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// One entry per day from the first counted day (or the window's start, if later) through today, so a quiet day shows as
// zero. Days before counting began are left out: nobody knows what happened then, and zero would be a claim.
export function buildDays({ today, since, firstDay, perDay, perDayChannel }) {
  if (!isDay(today) || !isDay(firstDay)) return [];
  let start = firstDay;
  if (isDay(since) && since > start) start = since;
  const byDay = new Map();
  for (const r of list(perDay)) if (r) byDay.set(r.day, r);
  const channels = new Map();
  for (const r of list(perDayChannel)) if (r) channels.set(`${r.day}|${r.channel}`, count(r.launches) || 0);
  const days = [];
  for (let day = start; day <= today && days.length < MAX_DAYS; day = nextDay(day)) {
    const row = byDay.get(day);
    days.push({
      day,
      launches: row ? count(row.launches) || 0 : 0,
      installs: row ? count(row.installs) || 0 : 0,
      publicLaunches: channels.get(`${day}|public`) || 0,
      experimentalLaunches: channels.get(`${day}|experimental`) || 0,
      partial: day === today,
    });
  }
  return days;
}

function breakdown(rows, label) {
  return list(rows)
    .filter(r => r && count(r.installs) !== null)
    .map(r => ({ label: label(r), installs: r.installs }));
}

// Turns the Worker's JSON into what the page draws. A number the Worker didn't send becomes null, shown as a dash, never 0.
export function normalizeStats(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !isDay(raw.today) || !Array.isArray(raw.launches_per_day)) {
    throw new LoadError('shape', 'unexpected stats');
  }
  const firstDay = isDay(raw.first_day) ? raw.first_day : null;
  const days = buildDays({ today: raw.today, since: raw.since, firstDay, perDay: raw.launches_per_day, perDayChannel: raw.launches_per_day_by_channel });
  return {
    generated: typeof raw.generated === 'string' ? raw.generated : null,
    today: raw.today,
    since: isDay(raw.since) ? raw.since : null,
    firstDay,
    activeToday: count(raw.daily_active_installs),
    activeWeek: count(raw.weekly_active_installs),
    activeMonth: count(raw.monthly_active_installs),
    installsEver: count(raw.installs_ever_seen),
    launches30d: count(raw.launches_30d),
    launchesEver: count(raw.launches_ever),
    autoupdates30d: count(raw.autoupdates_30d),
    autoupdatesEver: count(raw.autoupdates_ever),
    days,
    versions: breakdown(raw.installs_per_version, r => `${r.version} (${r.channel})`),
    channels: breakdown(raw.installs_per_channel, r => channelName(r.channel)),
    os: breakdown(raw.installs_per_os, r => String(r.os)),
    langs: breakdown(raw.installs_per_lang, r => String(r.lang)),
    empty: days.length === 0,
  };
}

// The biggest n rows plus an "Other" row for the rest, each with its share of the whole list.
export function topWithOther(rows, n = 8) {
  const total = rows.reduce((sum, r) => sum + r.installs, 0);
  const sorted = [...rows].sort((a, b) => b.installs - a.installs);
  const shown = sorted.slice(0, n);
  const rest = sorted.slice(n).reduce((sum, r) => sum + r.installs, 0);
  if (rest > 0) shown.push({ label: `Other (${sorted.length - n})`, installs: rest });
  const top = shown.reduce((max, r) => Math.max(max, r.installs), 0);
  return shown.map(r => ({ ...r, share: total ? r.installs / total : 0, width: top ? r.installs / top : 0 }));
}

// ---- words and numbers ----

export function channelName(channel) {
  if (channel === 'public') return 'Public';
  if (channel === 'experimental') return 'Experimental';
  return String(channel);
}

export function fmtNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US') : '—';
}

export function fmtShare(v) {
  if (!(v > 0)) return '0%';
  return v < 0.01 ? '<1%' : `${Math.round(v * 100)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// All dates here are UTC. The formatters never use the browser's time zone.
export function fmtDay(value, withYear = true) {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T00:00:00Z` : value);
  if (value === null || value === undefined || Number.isNaN(d.getTime())) return '—';
  const text = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return withYear ? `${text} ${d.getUTCFullYear()}` : text;
}

export function fmtTime(value) {
  const d = new Date(value);
  if (value === null || value === undefined || Number.isNaN(d.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

// Whole-number axis ticks with clean steps: 0, 5, 10, 15.
export function niceTicks(max, most = 4) {
  if (!(max > 0)) return [0, 1];
  const rough = Math.max(max / most, 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map(m => m * power).find(s => s >= rough);
  const ticks = [];
  for (let t = 0; t < max + step; t += step) ticks.push(t);
  return ticks;
}

export function describeError(error, source) {
  const kind = error && error.kind;
  if (source === 'downloads') {
    if (kind === 'rate') {
      const when = error.resetAt ? ` It resets at ${fmtTime(error.resetAt)}.` : '';
      return `GitHub's limit for anonymous requests from this network is used up.${when}`;
    }
    if (kind === 'network') return 'Couldn’t reach GitHub. Check your connection and try again.';
    if (kind === 'shape') return 'GitHub sent something this page doesn’t understand.';
    return `GitHub refused the request (${error && error.message ? error.message : 'unknown error'}).`;
  }
  if (kind === 'key') return 'That key wasn’t accepted.';
  if (kind === 'network') return 'Couldn’t reach the launch counter. Check your connection and try again.';
  if (kind === 'shape') return 'The launch counter sent something this page doesn’t understand.';
  return 'The launch counter had a problem. Try again in a moment.';
}
