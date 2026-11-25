// One-off golden generator for score.js parity. NOT run by the tests.
//
// Feeds each committed fixture site (site-*.json, pages in crawl.js's shape)
// through ranklabs-app's own buildGEOScores() — the source score.js was
// vendored from — with no strategy/listing/blog/business data, exactly the
// projection scoreSite() ports, and writes golden-*.json beside it.
//
// Re-run after re-vendoring score.js:
//
//   NODE_PATH=/home/box/ranklabs/runtime/ranklabs-app/node_modules \
//     node tests/instant-check/fixtures/generate-golden.cjs
//
// ranklabs-app's working tree moves; the goldens must describe the pinned
// version score.js was vendored from. So the pinned agents/ tree is exported
// with `git archive` into a temp dir and required from there (read-only on the
// ranklabs-app checkout: no checkout, no edits).

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = process.env.RANKLABS_APP_DIR || '/home/box/ranklabs/runtime/ranklabs-app';
const PIN = '6ea7afb';

const pinned = fs.mkdtempSync(path.join(os.tmpdir(), `ranklabs-app-${PIN}-`));
process.on('exit', () => fs.rmSync(pinned, { recursive: true, force: true }));
const tar = execFileSync('git', ['-C', APP, 'archive', '--format=tar', PIN, 'agents/'], { maxBuffer: 256 * 1024 * 1024 });
execFileSync('tar', ['-x', '-C', pinned], { input: tar });

const { buildGEOScores } = require(path.join(pinned, 'agents/report/index.js'));

for (const file of fs.readdirSync(__dirname).filter((f) => /^site-.+\.json$/.test(f)).sort()) {
  const pages = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  const crawlData = { metrics: pages[0]?.metrics || {}, pages };
  const geo = buildGEOScores(null, crawlData, null, null, null, null);
  const out = path.join(__dirname, file.replace(/^site-/, 'golden-'));
  fs.writeFileSync(out, `${JSON.stringify({ source: `ranklabs-app@${PIN}`, fixture: file, geo }, null, 2)}\n`);
  console.log(`${path.basename(out)}: overall ${geo.overall_score}`);
}
