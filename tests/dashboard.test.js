// Run from the repository root: node --test
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LoadError, RELEASES_URL, STATS_URL, assetKind, buildDays, describeError, fetchReleases, fetchStats, fmtDay, fmtNumber,
  fmtShare, fmtTime, niceTicks, normalizeStats, releaseChannel, summarizeDownloads, topWithOther,
} from '../dashboard/metrics.js';

afterEach(() => mock.timers.reset());

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, ...init });
const release = (tag, installer, checksum, extra = {}) => ({
  tag_name: tag, draft: false, prerelease: false, published_at: '2026-11-01T09:30:14Z', html_url: `https://github.com/x/${tag}`,
  assets: [
    { name: `HIDUSBF-${tag}-Setup.exe`, download_count: installer },
    { name: `HIDUSBF-${tag}-Setup.exe.sha256`, download_count: checksum },
  ],
  ...extra,
});
const stats = (over = {}) => ({
  generated: '2026-11-03T12:00:00.000Z', since: '2026-10-05', today: '2026-11-03', first_day: '2026-11-01', last_day: '2026-11-03',
  daily_active_installs: 2, weekly_active_installs: 3, monthly_active_installs: 3, installs_ever_seen: 4,
  launches_30d: 9, launches_ever: 12, autoupdates_30d: 1, autoupdates_ever: 2,
  launches_per_day: [{ day: '2026-11-01', launches: 4, installs: 2 }, { day: '2026-11-03', launches: 5, installs: 2 }],
  launches_per_day_by_channel: [
    { day: '2026-11-01', channel: 'public', launches: 4, installs: 2 },
    { day: '2026-11-03', channel: 'experimental', launches: 2, installs: 1 },
    { day: '2026-11-03', channel: 'public', launches: 3, installs: 1 },
  ],
  installs_per_version: [{ version: '4.2.3', channel: 'public', installs: 3 }],
  installs_per_channel: [{ channel: 'public', installs: 3 }],
  installs_per_os: [{ os: '10.0.26200', installs: 3 }],
  installs_per_lang: [{ lang: 'en-US', installs: 3 }],
  ...over,
});

// ---- release pagination and failures ----

test('fetchReleases follows pages until a short page', async () => {
  const urls = [];
  const fetchFn = async url => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return json(page === 1 ? Array.from({ length: 100 }, (_, i) => release(`v${i}`, 1, 0)) : [release('v-last', 1, 0)]);
  };
  const all = await fetchReleases(fetchFn);
  assert.equal(all.length, 101);
  assert.deepEqual(urls, [`${RELEASES_URL}?per_page=100&page=1`, `${RELEASES_URL}?per_page=100&page=2`]);
});

test('fetchReleases stops after an exactly full last page', async () => {
  const fetchFn = async url => json(new URL(url).searchParams.get('page') === '1' ? Array.from({ length: 100 }, () => release('v', 1, 0)) : []);
  assert.equal((await fetchReleases(fetchFn)).length, 100);
});

test('fetchReleases fails whole when a later page fails, instead of showing partial totals', async () => {
  const fetchFn = async url => new URL(url).searchParams.get('page') === '1'
    ? json(Array.from({ length: 100 }, () => release('v', 1, 0))) : new Response('', { status: 502 });
  await assert.rejects(fetchReleases(fetchFn), e => e.kind === 'http');
});

test('fetchReleases gives up on endless pages', async () => {
  await assert.rejects(fetchReleases(async () => json(Array.from({ length: 100 }, () => release('v', 1, 0)))), e => e.kind === 'shape');
});

test('fetchReleases names each failure', async () => {
  await assert.rejects(fetchReleases(async () => { throw new TypeError('offline'); }), e => e.kind === 'network');
  await assert.rejects(fetchReleases(async () => new Response('<html>', { status: 200 })), e => e.kind === 'shape');
  await assert.rejects(fetchReleases(async () => json({ message: 'x' })), e => e.kind === 'shape');
  await assert.rejects(fetchReleases(async () => new Response('', { status: 403 })), e => e.kind === 'http');
});

test('a rate limit reports when it resets', async () => {
  const limited = new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793683200' } });
  await assert.rejects(fetchReleases(async () => limited), e => {
    assert.equal(e.kind, 'rate');
    assert.equal(e.resetAt, new Date(1793683200 * 1000).toISOString());
    assert.match(describeError(e, 'downloads'), /resets at \d\d:\d\d:\d\d UTC/);
    return true;
  });
  await assert.rejects(fetchReleases(async () => new Response('', { status: 429 })), e => e.kind === 'rate' && e.resetAt === null);
});

test('fetchReleases sends no credentials', async () => {
  let options;
  await fetchReleases(async (_, o) => { options = o; return json([]); });
  assert.equal(options.credentials, 'omit');
  assert.equal(options.headers.Authorization, undefined);
});

// ---- download sums ----

test('assets are sorted into installer, checksum and other', () => {
  assert.equal(assetKind('HIDUSBF-4.2.3-Setup.exe'), 'installer');
  assert.equal(assetKind('HIDUSBF-4.2.3-Setup.exe.sha256'), 'checksum');
  assert.equal(assetKind('notes.txt'), 'other');
});

test('channel comes from the prerelease flag or an -exp tag', () => {
  assert.equal(releaseChannel({ tag_name: 'v4.2.3', prerelease: false }), 'public');
  assert.equal(releaseChannel({ tag_name: 'v4.2.3-exp.37', prerelease: false }), 'experimental');
  assert.equal(releaseChannel({ tag_name: 'v4.2.3', prerelease: true }), 'experimental');
});

test('summary keeps installers apart from checksums, leaves drafts out and splits channels', () => {
  const s = summarizeDownloads([
    release('v1.0.0', 10, 2, { published_at: '2026-10-01T00:00:00Z' }),
    release('v2.0.0-draft', 999, 999, { draft: true, published_at: null }),
    release('v2.0.0', 5, 1, { published_at: '2026-11-01T00:00:00Z' }),
    release('v2.1.0-exp.1', 3, 4, { prerelease: true, published_at: '2026-11-02T00:00:00Z' }),
  ]);
  assert.deepEqual(s.rows.map(r => r.tag), ['v2.1.0-exp.1', 'v2.0.0', 'v1.0.0']);
  assert.deepEqual(s.totals, { installer: 18, checksum: 7, other: 0, releases: 3 });
  assert.deepEqual(s.byChannel.public, { installer: 15, checksum: 3, other: 0, releases: 2 });
  assert.deepEqual(s.byChannel.experimental, { installer: 3, checksum: 4, other: 0, releases: 1 });
  assert.equal(s.latest.tag, 'v2.0.0', 'latest public release skips the prerelease');
  assert.equal(s.topInstaller, 10);
});

test('summary of nothing, and of odd assets, stays sane', () => {
  const empty = summarizeDownloads([]);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.latest, null);
  assert.equal(empty.totals.installer, 0);
  const odd = summarizeDownloads([{ tag_name: 'v1', assets: [{ name: 'a.exe' }, null, { name: 'b.exe', download_count: 'x' }] }, { tag_name: 'v2' }]);
  assert.equal(odd.totals.installer, 0);
  assert.equal(odd.rows.length, 2);
});

// ---- stats fetch ----

test('fetchStats sends the key as a bearer header only, uncached', async () => {
  let seen;
  await fetchStats('s3cret', async (url, options) => { seen = { url, options }; return json(stats()); });
  assert.equal(seen.url, STATS_URL);
  assert.ok(!seen.url.includes('s3cret'), 'key in URL');
  assert.equal(seen.options.headers.Authorization, 'Bearer s3cret');
  assert.equal(seen.options.cache, 'no-store');
  assert.equal(seen.options.credentials, 'omit');
});

test('fetchStats tells a refused key from a broken server', async () => {
  for (const status of [401, 403, 404]) await assert.rejects(fetchStats('k', async () => new Response('', { status })), e => e.kind === 'key');
  await assert.rejects(fetchStats('k', async () => new Response('', { status: 500 })), e => e.kind === 'server');
  await assert.rejects(fetchStats('k', async () => { throw new TypeError('offline'); }), e => e.kind === 'network');
  await assert.rejects(fetchStats('k', async () => new Response('nope')), e => e.kind === 'shape');
  await assert.rejects(fetchStats('k', async () => json({ today: 'yesterday', launches_per_day: [] })), e => e.kind === 'shape');
});

test('error messages never repeat the key', () => {
  for (const kind of ['key', 'network', 'shape', 'server']) {
    const text = describeError(new LoadError(kind, 'x'), 'usage');
    assert.ok(text.length > 0 && !text.includes('s3cret'));
  }
});

// ---- dates ----

test('quiet days are filled with zeros, with channels split', () => {
  const n = normalizeStats(stats());
  assert.deepEqual(n.days, [
    { day: '2026-11-01', launches: 4, installs: 2, publicLaunches: 4, experimentalLaunches: 0, partial: false },
    { day: '2026-11-02', launches: 0, installs: 0, publicLaunches: 0, experimentalLaunches: 0, partial: false },
    { day: '2026-11-03', launches: 5, installs: 2, publicLaunches: 3, experimentalLaunches: 2, partial: true },
  ]);
});

test('days before counting began are left out, never shown as zero', () => {
  assert.equal(normalizeStats(stats()).days[0].day, '2026-11-01');
});

test('an old first day is cut to the 30-day window', () => {
  const days = buildDays({ today: '2026-11-03', since: '2026-10-05', firstDay: '2026-01-01', perDay: [] });
  assert.equal(days.length, 30);
  assert.equal(days[0].day, '2026-10-05');
  assert.equal(days[29].day, '2026-11-03');
});

test('day walking crosses month and year ends in UTC', () => {
  const days = buildDays({ today: '2027-01-02', since: '2026-12-30', firstDay: '2026-12-30', perDay: [] });
  assert.deepEqual(days.map(d => d.day), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});

test('rows outside the window are ignored', () => {
  const days = buildDays({ today: '2026-11-03', since: '2026-11-03', firstDay: '2026-11-01', perDay: [{ day: '2026-11-01', launches: 50, installs: 5 }] });
  assert.deepEqual(days.map(d => d.launches), [0]);
});

// ---- null and empty states ----

test('an empty counter reads as empty', () => {
  const n = normalizeStats(stats({
    first_day: null, last_day: null, launches_per_day: [], launches_per_day_by_channel: [], installs_per_version: [],
    installs_per_channel: [], installs_per_os: [], installs_per_lang: [],
  }));
  assert.equal(n.empty, true);
  assert.deepEqual(n.days, []);
});

test('a number the Worker did not send is a dash, not a zero', () => {
  const raw = stats();
  delete raw.weekly_active_installs;
  delete raw.launches_30d;
  raw.installs_ever_seen = 'lots';
  raw.autoupdates_30d = -1;
  const n = normalizeStats(raw);
  assert.equal(n.activeWeek, null);
  assert.equal(n.launches30d, null);
  assert.equal(n.installsEver, null);
  assert.equal(n.autoupdates30d, null);
  assert.equal(fmtNumber(n.activeWeek), '—');
  assert.equal(n.activeToday, 2);
  assert.equal(fmtNumber(0), '0');
});

test('a Worker without the channel split still gives daily totals', () => {
  const raw = stats();
  delete raw.launches_per_day_by_channel;
  assert.equal(normalizeStats(raw).days[2].launches, 5);
});

test('normalized stats carry no install ids', () => {
  assert.ok(!/"id"/.test(JSON.stringify(normalizeStats(stats()))));
});

// ---- formatting ----

test('dates are UTC whatever the browser zone', () => {
  assert.equal(fmtDay('2026-11-03'), '3 Nov 2026');
  assert.equal(fmtDay('2026-11-03', false), '3 Nov');
  assert.equal(fmtDay('2026-11-03T23:59:59Z'), '3 Nov 2026');
  assert.equal(fmtDay(null), '—');
  assert.equal(fmtDay('garbage'), '—');
  assert.equal(fmtTime('2026-11-03T04:05:06Z'), '04:05:06 UTC');
  assert.equal(fmtTime(null), '—');
});

test('axis ticks are whole, clean and reach past the top value', () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(1), [0, 1]);
  assert.deepEqual(niceTicks(3), [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(11), [0, 5, 10, 15]);
  assert.deepEqual(niceTicks(346), [0, 100, 200, 300, 400]);
  for (const max of [2, 7, 19, 99, 101, 1234, 99999]) {
    const t = niceTicks(max);
    assert.ok(t[t.length - 1] >= max, `top tick for ${max}`);
    assert.ok(t.every(Number.isInteger));
    assert.ok(t.length <= 6, `tick count for ${max}`);
  }
});

test('shares and the Other row add up', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ label: `v${i}`, installs: 10 - i }));
  const top = topWithOther(rows, 8);
  assert.equal(top.length, 9);
  assert.equal(top[8].label, 'Other (2)');
  assert.equal(top[8].installs, 3);
  assert.equal(top.reduce((sum, r) => sum + r.installs, 0), 55);
  assert.equal(top[0].width, 1);
  assert.deepEqual(topWithOther([]), []);
  assert.equal(fmtShare(0), '0%');
  assert.equal(fmtShare(0.001), '<1%');
  assert.equal(fmtShare(0.5), '50%');
});

// ---- the page itself ----

const page = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../dashboard/dashboard.js', import.meta.url), 'utf8');
const metrics = readFileSync(new URL('../dashboard/metrics.js', import.meta.url), 'utf8');

test('the page is locked down and stays out of search', () => {
  assert.match(page, /name="robots" content="noindex"/);
  assert.match(page, /name="referrer" content="no-referrer"/);
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(page)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src https:\/\/api\.github\.com https:\/\/hidusbf-ping\.kronussells\.workers\.dev;/);
  assert.ok(!csp.includes('unsafe'), 'no unsafe CSP values');
});

test('the key field is a password field, and no script stores the key or reads it from the URL', () => {
  assert.match(page, /id="stats-key"[^>]*type="password"/);
  for (const source of [script, metrics]) {
    for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'location.search', 'location.hash', 'innerHTML', 'console.', '?key=']) {
      assert.ok(!source.includes(banned), `script uses ${banned}`);
    }
  }
});
