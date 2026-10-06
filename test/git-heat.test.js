'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {parseRename, parseLog, whitespaceComplexity, globToRegExp, makeFilter, analyze, renderMarkdown, renderHtml} = require('../git-heat.js');

test('parseRename handles every git numstat rename notation', () => {
  assert.deepEqual(parseRename('src/{old => new}/a.js'), {from: 'src/old/a.js', to: 'src/new/a.js'});
  assert.deepEqual(parseRename('old.js => new.js'), {from: 'old.js', to: 'new.js'});
  assert.deepEqual(parseRename('lib/{a.js => b.js}'), {from: 'lib/a.js', to: 'lib/b.js'});
  assert.deepEqual(parseRename('dir/{ => sub}/f.js'), {from: 'dir/f.js', to: 'dir/sub/f.js'});
  assert.deepEqual(parseRename('{src => lib}/x.js'), {from: 'src/x.js', to: 'lib/x.js'});
  assert.equal(parseRename('plain/path.js'), null);
});

test('parseLog follows a file across renames (newest first)', () => {
  const S = '\x1e', F = '\x1f';
  const raw = [
    `${S}c3${F}Ann${F}ann@x.io${F}300\n\n5\t1\tlib/b.js\n`,
    `${S}c2${F}Bob${F}BOB@x.io${F}200\n\n0\t0\t{src => lib}/b.js\n`,
    `${S}c1${F}Ann${F}ann@x.io${F}100\n\n10\t0\tsrc/b.js\n1\t1\tREADME.md\n`,
  ].join('');
  const commits = parseLog(raw);
  assert.equal(commits.length, 3);
  assert.deepEqual(commits.map(c => c.files[0].path), ['lib/b.js', 'lib/b.js', 'lib/b.js']);
  assert.equal(commits[1].email, 'bob@x.io');
  assert.equal(commits[2].files[1].path, 'README.md');
});

test('whitespaceComplexity measures nesting with 2- or 4-space and tab indents', () => {
  const four = 'a\n    b\n        c\n\n    d\n';
  assert.deepEqual(whitespaceComplexity(four), {loc: 4, complexity: 4, maxDepth: 2});
  const two = 'a\n  b\n    c\n  d\n';
  assert.deepEqual(whitespaceComplexity(two), {loc: 4, complexity: 4, maxDepth: 2});
  const tabs = 'a\n\tb\n\t\tc\n';
  assert.deepEqual(whitespaceComplexity(tabs), {loc: 3, complexity: 3, maxDepth: 2});
});

test('globs and default excludes', () => {
  assert.ok(globToRegExp('**/*.js').test('a/b/c.js'));
  assert.ok(globToRegExp('**/*.js').test('c.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  const keep = makeFilter([], ['docs/**']);
  assert.ok(keep('src/index.js'));
  assert.ok(!keep('docs/guide.md'));
  assert.ok(!keep('package-lock.json'));
  assert.ok(!keep('web/node_modules/x/index.js'));
  assert.ok(!keep('assets/app.min.js'));
});

test('code / test / bot detection', () => {
  const {isCode, isTest, isBot} = require('../git-heat.js');
  assert.ok(isCode('src/app.tsx') && isCode('Dockerfile') && isCode('lib/x.py'));
  assert.ok(!isCode('package.json') && !isCode('README.md') && !isCode('.github/workflows/ci.yml'));
  assert.ok(isTest('test/a.js') && isTest('src/a.spec.ts') && isTest('pkg/__tests__/x.js'));
  assert.ok(!isTest('src/latest.js') && !isTest('src/contest/x.js'));
  assert.ok(isBot('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com'));
  assert.ok(isBot('renovate', 'x@y.z') && isBot('github-actions', 'x@y.z'));
  assert.ok(!isBot('Ann', 'ann@x.io') && !isBot('Robot Arm', 'robot@x.io'));
});

/* ---------- end-to-end on a real throwaway repo ---------- */

function makeRepo(){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-heat-'));
  const run = (args, env = {}) => execFileSync('git', args, {cwd: dir, env: {...process.env, ...env}, stdio: 'pipe'});
  run(['init', '-q', '-b', 'main']);
  run(['config', 'commit.gpgsign', 'false']);
  let t = Math.floor(Date.now() / 1000) - 200 * 86400;
  const commit = (author, files, msg = 'change') => {
    for (const [p, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), {recursive: true});
      fs.writeFileSync(path.join(dir, p), content);
    }
    run(['add', '-A']);
    t += 86400;
    const [name, email] = author;
    run(['commit', '-q', '-m', msg], {GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000`});
  };
  return {dir, run, commit};
}

const nested = n => Array.from({length: n}, (_, i) => '    '.repeat(1 + (i % 4)) + `line${i}`).join('\n') + '\n';

test('analyze: hotspots, renames, coupling, islands and bus factor', () => {
  const {dir, run, commit} = makeRepo();
  const ann = ['Ann', 'ann@x.io'], bob = ['Bob', 'bob@x.io'], old = ['Olga', 'olga@x.io'];
  // Olga writes a big module, then disappears (knowledge island, orphaned)
  commit(old, {'legacy/billing.js': nested(120)});
  commit(old, {'legacy/billing.js': nested(125)});
  // api/routes.js and web/form.js always change together (cross-module coupling)
  for (let i = 0; i < 8; i++) commit(i % 2 ? ann : bob, {'api/routes.js': nested(200 + i), 'web/form.js': nested(60 + i)});
  // src/core.js gets renamed to lib/core.js, history must follow
  commit(ann, {'src/core.js': nested(80)});
  commit(ann, {'src/core.js': nested(82)});
  fs.mkdirSync(path.join(dir, 'lib'));
  run(['mv', 'src/core.js', 'lib/core.js']);
  commit(ann, {'lib/core.js': nested(84)});
  commit(bob, {'README.md': 'hello\n', 'package-lock.json': '{}\n'});

  const r = analyze({repo: dir, since: '5 years ago', include: [], exclude: [], minShared: 5});
  assert.equal(r.commits, 14);
  assert.equal(r.authors, 3);

  // hottest file = the one that is both big and changed the most
  assert.equal(r.hotspots[0].path, 'api/routes.js');
  assert.equal(r.hotspots[0].revisions, 8);

  // rename followed: 3 revisions, not 1
  const core = r.files.find(f => f.path === 'lib/core.js');
  assert.equal(core.revisions, 3);
  assert.ok(!r.files.some(f => f.path === 'src/core.js'));

  // lock files are excluded by default
  assert.ok(!r.files.some(f => f.path === 'package-lock.json'));

  // coupling
  const pair = r.coupling.find(p => p.a === 'api/routes.js' && p.b === 'web/form.js');
  assert.ok(pair, 'expected api/routes.js ⟷ web/form.js');
  assert.equal(pair.shared, 8);
  assert.equal(pair.degree, 100);
  assert.equal(pair.crossModule, true);

  // knowledge island: Olga owns billing.js and has been gone > 90 days
  const isl = r.islands.find(f => f.path === 'legacy/billing.js');
  assert.ok(isl);
  assert.equal(isl.owner, 'Olga');
  assert.equal(isl.orphaned, true);

  assert.ok(r.busFactor >= 1 && r.busFactor <= 3);

  // renderers don't throw and escape what they print
  assert.match(renderMarkdown(r, {top: 5}), /api\/routes\.js/);
  const html = renderHtml(r);
  assert.match(html, /git-heat/);
  assert.ok(!html.includes('</script><script>'));

  fs.rmSync(dir, {recursive: true, force: true});
});

test('CLI prints a report, JSON and writes HTML', () => {
  const {dir, commit} = makeRepo();
  for (let i = 0; i < 4; i++) commit(['Ann', 'ann@x.io'], {'a.js': nested(10 + i)});
  const cli = path.join(__dirname, '..', 'git-heat.js');
  const term = execFileSync(process.execPath, [cli, dir, '--since', '5 years ago', '--no-color'], {encoding: 'utf8'});
  assert.match(term, /HOTSPOTS/);
  assert.match(term, /a\.js/);
  const json = JSON.parse(execFileSync(process.execPath, [cli, dir, '--since', '5 years ago', '--json'], {encoding: 'utf8'}));
  assert.equal(json.hotspots[0].path, 'a.js');
  const out = path.join(dir, 'report.html');
  execFileSync(process.execPath, [cli, dir, '--since', '5 years ago', '--html', out, '--no-color'], {encoding: 'utf8'});
  assert.ok(fs.statSync(out).size > 1000);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('CLI fails cleanly outside a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-heat-nogit-'));
  const cli = path.join(__dirname, '..', 'git-heat.js');
  assert.throws(() => execFileSync(process.execPath, [cli, dir], {encoding: 'utf8', stdio: 'pipe'}),
    e => /not a git repository/.test(e.stderr));
  fs.rmSync(dir, {recursive: true, force: true});
});
