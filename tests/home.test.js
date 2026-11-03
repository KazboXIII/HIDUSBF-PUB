import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const html = read('index.html');

test('hero keeps its wording, buttons and metadata, and ends at the metadata line', () => {
  const hero = html.slice(html.indexOf('<section class="hero">'), html.indexOf('</section>'));
  for (const piece of [
    '<div class="glow" aria-hidden="true"></div>',
    '<img class="hero-icon" src="assets/icon.svg" alt="" width="88" height="88">',
    '<p class="eyebrow">For Windows</p>',
    '<h1>HIDUSBF</h1>',
    '<p class="lede">Overclock the polling rate of your mouse, keyboard or controller, and calibrate your controller\'s sticks. All in one place.</p>',
    '<a class="button" href="#features">See what it does</a>',
    '<p class="fine" id="download-meta">Free · Windows 8.1, 10 and 11 · 64-bit</p>',
  ]) assert.ok(hero.includes(piece), piece);
  assert.ok(hero.trimEnd().endsWith('</p>'), 'nothing follows the metadata line inside the hero');
});

test('homepage styles leave the shared stylesheet to the other pages', () => {
  for (const page of ['information/index.html', 'dashboard/index.html']) {
    assert.ok(!read(page).includes('home.css'), page);
    assert.ok(!read(page).includes('home.js'), page);
  }
  const rules = read('home.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = rules.match(/[^{}]+(?=\{)/g).map((s) => s.trim()).filter((s) => !s.startsWith('@'));
  const allowed = /^(html|\.hero|\.hero \.glow|@|[0-9%]|footer\.h-footer|#h-lightbox|.*\.h-|#details|#install)/;
  for (const selector of selectors) assert.match(selector, allowed, selector);
});

test('release links use the public repository, never the private one', () => {
  for (const file of ['index.html', 'home.js', 'README.md', 'dashboard/metrics.js', 'information/index.html']) {
    const names = read(file).match(/KazboXIII\/[\w.-]+/g) || [];
    for (const name of names) assert.equal(name, 'KazboXIII/HIDUSBF-PUB', `${file}: ${name}`);
  }
});

test('local files and in-page links on the homepage exist', () => {
  for (const [, url] of html.matchAll(/(?:src|href)="([^"#:]+?)\/?"/g)) {
    assert.ok(existsSync(join(root, url)), url);
  }
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) {
    assert.ok(html.includes(`id="${id}"`), `#${id}`);
  }
  const js = read('home.js');
  for (const [, tab] of html.matchAll(/data-screen="(\w+)"/g)) {
    assert.ok(existsSync(join(root, 'assets/app', `${tab}.png`)), tab);
    assert.match(js, new RegExp(`${tab}: \\{`), tab);
  }
});

test('required credits stay in the footer', () => {
  const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
  for (const credit of ['hidusbf by SweetLow (Public Domain)', 'Jeshua Starr Scully', 'Battle Beaver Customs', 'dualshock-tools by the_al (MIT)', 'IBM Plex (SIL Open Font License)']) {
    assert.ok(footer.includes(credit), credit);
  }
});
