#!/usr/bin/env node
'use strict';
// git-heat — find the code that will hurt you next.
// Zero dependencies. Reads your git history (read-only) and ranks hotspots,
// hidden coupling, knowledge islands and your bus factor.

const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '1.0.0';
const DAY = 86400;

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const HELP = `
git-heat ${VERSION} — find the code that will hurt you next

Usage
  git-heat [repo] [options]

Options
  --since <when>     History window, anything git understands (default: "1 year ago")
  --top <n>          Rows per section (default: 10)
  --exclude <glob>   Ignore paths (repeatable), e.g. --exclude "docs/**"
  --include <glob>   Only analyse matching paths (repeatable)
  --min-shared <n>   Min. shared commits for a coupling pair (default: 5)
  --all-files        Also rank docs, config and data files (default: source code only)
  --include-bots     Count commits from bots (dependabot, renovate, …)
  --json             Print the full analysis as JSON
  --md               Print a Markdown report (great for PR comments / CI summaries)
  --html [file]      Write an interactive HTML report (default: git-heat.html)
  --no-color         Disable colors (also respects NO_COLOR)
  -h, --help         Show this help
  -v, --version      Show version

Examples
  git-heat
  git-heat ../api --since "6 months ago" --top 20
  git-heat --html && open git-heat.html
  git-heat --md >> "$GITHUB_STEP_SUMMARY"
`;

function parseArgs(argv){
  const o = {repo: '.', since: '1 year ago', top: 10, exclude: [], include: [], minShared: 5,
    allFiles: false, includeBots: false, json: false, md: false, html: null, color: !process.env.NO_COLOR && process.stdout.isTTY};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '-h': case '--help': process.stdout.write(HELP); process.exit(0); break;
      case '-v': case '--version': console.log(VERSION); process.exit(0); break;
      case '--since': o.since = next(); break;
      case '--top': o.top = Math.max(1, parseInt(next(), 10) || 10); break;
      case '--exclude': o.exclude.push(next()); break;
      case '--include': o.include.push(next()); break;
      case '--min-shared': o.minShared = Math.max(2, parseInt(next(), 10) || 5); break;
      case '--all-files': o.allFiles = true; break;
      case '--include-bots': o.includeBots = true; break;
      case '--json': o.json = true; break;
      case '--md': o.md = true; break;
      case '--html': o.html = (argv[i + 1] && !argv[i + 1].startsWith('-')) ? argv[++i] : 'git-heat.html'; break;
      case '--no-color': o.color = false; break;
      default:
        if (a.startsWith('-')) fail(`Unknown option ${a} (see --help)`);
        o.repo = a;
    }
  }
  return o;
}

function fail(msg){
  process.stderr.write(`git-heat: ${msg}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Paths & globs                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_EXCLUDES = [
  '**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**',
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/composer.lock', '**/Cargo.lock',
  '**/poetry.lock', '**/Gemfile.lock', '**/go.sum', '**/*.lock',
  '**/*.min.js', '**/*.min.css', '**/*.map', '**/*.snap', '**/__snapshots__/**',
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.ico', '**/*.svg', '**/*.pdf',
  '**/*.woff', '**/*.woff2', '**/*.ttf', '**/*.eot', '**/*.zip', '**/*.gz',
  '**/CHANGELOG*', '**/CHANGES*', '**/HISTORY*',
];

// Hotspots are about code: docs, config and data churn (package.json bumps, changelogs, CI) is noise.
const CODE_EXT = new Set(('js mjs cjs jsx ts mts cts tsx vue svelte astro py rb php java kt kts scala groovy go rs c h cc cpp cxx hpp hh ' +
  'cs fs vb swift m mm dart lua pl pm r jl ex exs erl hrl clj cljs elm hs ml mli nim zig sol sh bash zsh ps1 sql ' +
  'css scss sass less styl html htm twig blade erb hbs ejs pug liquid gd tf').split(' '));
const isCode = p => {
  const base = p.split('/').pop();
  if (/^(Dockerfile|Makefile|Rakefile|Gemfile|Jenkinsfile)$/.test(base)) return true;
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return CODE_EXT.has(ext);
};
const isTest = p => /(^|[/._-])(test|tests|spec|specs|__tests__|e2e)([/._-]|$)/i.test(p);
const isBot = (name, email) => /\[bot\]/i.test(`${name} ${email}`)
  || /^(dependabot|renovate|greenkeeper|github-actions|snyk-bot|semantic-release-bot|pre-commit-ci)\b/i.test(name);

function globToRegExp(glob){
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function makeFilter(include, exclude){
  const inc = include.map(globToRegExp);
  const exc = [...DEFAULT_EXCLUDES, ...exclude].map(globToRegExp);
  return p => (!inc.length || inc.some(r => r.test(p))) && !exc.some(r => r.test(p));
}

// "src/{old => new}/a.js" | "old.js => new.js" | "{a => b}" | "dir/{ => sub}/f.js"
function parseRename(p){
  if (!p.includes(' => ')) return null;
  const m = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  const clean = s => s.replace(/\/{2,}/g, '/').replace(/^\//, '');
  if (m) return {from: clean(m[1] + m[2] + m[4]), to: clean(m[1] + m[3] + m[4])};
  const [from, to] = p.split(' => ');
  return {from, to};
}

/* ------------------------------------------------------------------ */
/* Git                                                                 */
/* ------------------------------------------------------------------ */

function git(repo, args){
  try {
    return execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...args],
      {encoding: 'utf8', maxBuffer: 1024 * 1024 * 512, stdio: ['ignore', 'pipe', 'pipe']});
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().trim().split('\n')[0];
    fail(msg.includes('not a git repository') ? `${path.resolve(repo)} is not a git repository` : msg);
  }
}

// Parses `git log --numstat` output (newest first) into commits with
// rename-resolved paths, so a file keeps its history across renames.
function parseLog(raw){
  const alias = new Map();
  const canonical = p => { let seen = 0; while (alias.has(p) && seen++ < 50) p = alias.get(p); return p; };
  const commits = [];
  for (const rec of raw.split('\x1e')) {
    if (!rec.trim()) continue;
    const lines = rec.split('\n');
    const [hash, name, email, ts] = lines[0].split('\x1f');
    const files = [];
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l) continue;
      const parts = l.split('\t');
      if (parts.length < 3) continue;
      const added = parts[0] === '-' ? 0 : +parts[0], deleted = parts[1] === '-' ? 0 : +parts[1];
      let p = parts.slice(2).join('\t');
      const rn = parseRename(p);
      if (rn) { const to = canonical(rn.to); if (rn.from !== to) alias.set(rn.from, to); p = to; }
      else p = canonical(p);
      files.push({path: p, added, deleted, binary: parts[0] === '-'});
    }
    commits.push({hash, author: name, email: (email || '').toLowerCase(), time: +ts, files});
  }
  return commits;
}

/* ------------------------------------------------------------------ */
/* Complexity                                                          */
/* ------------------------------------------------------------------ */

// Language-agnostic "whitespace complexity": total logical indentation.
// Indentation tracks nesting well enough to rank files, in any language.
function whitespaceComplexity(text){
  const lines = text.split('\n');
  const indents = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = l.match(/^[ \t]*/)[0];
    indents.push(m);
  }
  const spaceIndents = indents.filter(s => s && !s.includes('\t')).map(s => s.length);
  const twoSpace = spaceIndents.length && spaceIndents.filter(n => n % 4 !== 0).length > spaceIndents.length * 0.2;
  const unit = twoSpace ? 2 : 4;
  let total = 0, max = 0;
  for (const s of indents) {
    const tabs = (s.match(/\t/g) || []).length, spaces = s.length - tabs;
    const lvl = tabs + Math.floor(spaces / unit);
    total += lvl; if (lvl > max) max = lvl;
  }
  return {loc: indents.length, complexity: total, maxDepth: max};
}

function isProbablyBinary(buf){
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

function analyze(opts){
  const repo = opts.repo;
  const root = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const keep = makeFilter(opts.include, opts.exclude);
  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean)
    .filter(p => keep(p) && (opts.allFiles || isCode(p)));

  const raw = git(root, ['log', '--no-merges', '--numstat', '-M', `--since=${opts.since}`,
    '--format=%x1e%H%x1f%aN%x1f%aE%x1f%at']);
  const commits = parseLog(raw).filter(c => opts.includeBots || !isBot(c.author, c.email));
  const now = Math.floor(Date.now() / 1000);

  // Current size & complexity of tracked files
  const files = new Map();
  for (const p of tracked) {
    let buf;
    try {
      const st = fs.statSync(path.join(root, p));
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      buf = fs.readFileSync(path.join(root, p));
    } catch { continue; }
    if (isProbablyBinary(buf)) continue;
    const c = whitespaceComplexity(buf.toString('utf8'));
    if (!c.loc) continue;
    files.set(p, {path: p, ...c, revisions: 0, churn: 0, authors: new Map(), lastTouch: 0, firstTouch: Infinity, recent: 0});
  }

  // History
  const authors = new Map();   // email -> {name, commits, last, first}
  const pairs = new Map();     // "a\0b" -> shared commits
  const RECENT = now - 30 * DAY;
  for (const c of commits) {
    const a = authors.get(c.email) || {name: c.author, email: c.email, commits: 0, last: 0, first: Infinity};
    a.commits++; a.last = Math.max(a.last, c.time); a.first = Math.min(a.first, c.time);
    authors.set(c.email, a);
    const touched = [];
    for (const f of c.files) {
      const info = files.get(f.path);
      if (!info) continue;
      info.revisions++;
      info.churn += f.added + f.deleted;
      info.lastTouch = Math.max(info.lastTouch, c.time);
      info.firstTouch = Math.min(info.firstTouch, c.time);
      if (c.time >= RECENT) info.recent++;
      info.authors.set(c.email, (info.authors.get(c.email) || 0) + Math.max(1, f.added));
      touched.push(f.path);
    }
    // Big sweeping commits (formatting, renames) say nothing about coupling
    if (touched.length >= 2 && touched.length <= 25) {
      touched.sort();
      for (let i = 0; i < touched.length; i++)
        for (let j = i + 1; j < touched.length; j++) {
          const k = touched[i] + '\0' + touched[j];
          pairs.set(k, (pairs.get(k) || 0) + 1);
        }
    }
  }

  const list = [...files.values()];
  const maxRev = Math.max(1, ...list.map(f => f.revisions));
  const maxCx = Math.max(1, ...list.map(f => f.complexity));
  const windowDays = commits.length ? Math.max(30, (now - Math.min(...commits.map(c => c.time))) / DAY) : 365;

  for (const f of list) {
    // Hotspot = changes often AND is complex. Log on complexity keeps one giant file from flattening the scale.
    f.score = Math.round(100 * (f.revisions / maxRev) * (Math.log1p(f.complexity) / Math.log1p(maxCx)));
    const tot = [...f.authors.values()].reduce((s, v) => s + v, 0);
    const owners = [...f.authors.entries()].sort((x, y) => y[1] - x[1]);
    f.mainAuthor = owners[0] ? owners[0][0] : null;
    f.mainShare = owners[0] ? owners[0][1] / tot : 0;
    f.authorCount = owners.length;
    // Heating up: last 30 days vs. the average month of the window
    const monthly = f.revisions / (windowDays / 30);
    f.heat = f.recent >= 3 && monthly > 0 ? f.recent / monthly : 0;
  }

  const hotspots = list.filter(f => f.revisions > 0).sort((a, b) => b.score - a.score || b.revisions - a.revisions);

  const coupling = [];
  for (const [k, shared] of pairs) {
    if (shared < opts.minShared) continue;
    const [a, b] = k.split('\0');
    const ra = files.get(a).revisions, rb = files.get(b).revisions;
    const degree = shared / ((ra + rb) / 2);
    if (degree < 0.5) continue;
    const da = a.split('/').slice(0, -1).join('/'), db = b.split('/').slice(0, -1).join('/');
    const testPair = isTest(a) !== isTest(b);   // code + its test changing together is healthy
    coupling.push({a, b, shared, degree: Math.round(degree * 100),
      crossModule: da !== db && !isTest(a) && !isTest(b), testPair});
  }
  // Most surprising first: cross-module, then code⟷code, then test⟷test, then code⟷its test (expected)
  const rank = p => p.crossModule ? 0 : (!isTest(p.a) && !isTest(p.b)) ? 1 : p.testPair ? 3 : 2;
  coupling.sort((x, y) => (rank(x) - rank(y)) || (y.degree - x.degree) || (y.shared - x.shared));

  const STALE = now - 90 * DAY;
  const islands = list
    .filter(f => f.revisions >= 2 && f.loc >= 50 && f.mainShare >= 0.8 && f.mainAuthor)
    .map(f => {
      const a = authors.get(f.mainAuthor);
      return {path: f.path, owner: a.name, share: Math.round(f.mainShare * 100), loc: f.loc,
        ownerLastSeen: a.last, orphaned: a.last < STALE};
    })
    .sort((x, y) => (y.orphaned - x.orphaned) || (isTest(x.path) - isTest(y.path)) || (y.loc - x.loc));

  // Bus factor: how many top owners can leave before >50% of the code has no active owner
  const owned = list.filter(f => f.mainAuthor);
  const byOwner = new Map();
  for (const f of owned) byOwner.set(f.mainAuthor, (byOwner.get(f.mainAuthor) || 0) + f.loc);
  const totalLoc = owned.reduce((s, f) => s + f.loc, 0);
  const ranked = [...byOwner.entries()].sort((x, y) => y[1] - x[1]);
  let lost = 0, busFactor = 0;
  const busAuthors = [];
  for (const [email, loc] of ranked) {
    if (lost > totalLoc / 2) break;
    lost += loc; busFactor++; busAuthors.push(authors.get(email).name);
  }

  const heating = list.filter(f => f.heat >= 2).sort((a, b) => b.heat - a.heat);

  return {
    version: VERSION,
    repo: path.basename(root), root, since: opts.since, generatedAt: new Date(now * 1000).toISOString(),
    commits: commits.length, authors: authors.size, filesAnalysed: list.length,
    totalLoc: list.reduce((s, f) => s + f.loc, 0),
    busFactor, busAuthors,
    hotspots: hotspots.map(slim(authors)),
    coupling, islands,
    heating: heating.map(slim(authors)),
    files: list.map(slim(authors)),
  };
}

const slim = authors => f => ({
  path: f.path, score: f.score, revisions: f.revisions, churn: f.churn, loc: f.loc,
  complexity: f.complexity, maxDepth: f.maxDepth, authors: f.authorCount,
  mainAuthor: f.mainAuthor ? authors.get(f.mainAuthor).name : null, mainShare: Math.round(f.mainShare * 100),
  lastTouch: f.lastTouch || null, recent: f.recent, heat: Math.round(f.heat * 10) / 10,
});

/* ------------------------------------------------------------------ */
/* Terminal output                                                     */
/* ------------------------------------------------------------------ */

function colors(on){
  const w = (a, b) => s => on ? `\x1b[${a}m${s}\x1b[${b}m` : String(s);
  return {bold: w(1, 22), dim: w(2, 22), red: w(31, 39), yellow: w(33, 39), green: w(32, 39), cyan: w(36, 39),
    magenta: w(35, 39), gray: w(90, 39),
    heat: (s, v) => !on ? String(s) : v >= 70 ? `\x1b[38;5;196m${s}\x1b[39m` : v >= 40 ? `\x1b[38;5;208m${s}\x1b[39m`
      : v >= 20 ? `\x1b[38;5;220m${s}\x1b[39m` : `\x1b[38;5;110m${s}\x1b[39m`};
}

const ago = t => {
  if (!t) return '—';
  const d = (Date.now() / 1000 - t) / DAY;
  return d < 1 ? 'today' : d < 60 ? `${Math.round(d)}d ago` : d < 730 ? `${Math.round(d / 30)}mo ago` : `${(d / 365).toFixed(1)}y ago`;
};
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
const lpad = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
const trunc = (s, n) => s.length <= n ? s : '…' + s.slice(s.length - n + 1);
const bar = (v, w = 12) => { const f = Math.round(v / 100 * w); return '█'.repeat(f) + '░'.repeat(w - f); };

function renderTerminal(r, o){
  const c = colors(o.color), out = [];
  const W = Math.min(process.stdout.columns || 100, 120);
  const fileW = Math.max(24, W - 52);
  out.push('');
  out.push(`  ${c.bold('🔥 git-heat')} ${c.dim('·')} ${c.bold(r.repo)} ${c.dim(`· since ${r.since} · ${r.commits} commits · ${r.authors} authors · ${r.filesAnalysed} files · ${r.totalLoc.toLocaleString('en')} lines`)}`);
  out.push('');

  if (!r.commits) {
    out.push(c.yellow(`  No commits found since "${r.since}". Try --since "5 years ago".`), '');
    return out.join('\n');
  }

  out.push(`  ${c.bold('HOTSPOTS')} ${c.dim('— complex files that keep changing. Refactor these first.')}`);
  out.push(c.dim(`  ${pad('', 3)}${pad('heat', 18)}${pad('file', fileW)}${lpad('revs', 6)}${lpad('lines', 7)}${lpad('authors', 9)}`));
  r.hotspots.slice(0, o.top).forEach((f, i) => {
    out.push(`  ${c.dim(lpad(i + 1, 2))} ${c.heat(bar(f.score), f.score)} ${c.heat(lpad(f.score, 3), f.score)}  ${pad(trunc(f.path, fileW - 2), fileW)}${lpad(f.revisions, 6)}${lpad(f.loc, 7)}${lpad(f.authors, 9)}`);
  });
  out.push('');

  const coup = r.coupling.slice(0, o.top);
  out.push(`  ${c.bold('HIDDEN COUPLING')} ${c.dim('— files that always change together. Missing abstraction?')}`);
  if (!coup.length) out.push(c.dim(`  none found (min ${o.minShared} shared commits, ≥50% together)`));
  coup.forEach(p => {
    const tag = p.crossModule ? c.magenta(' cross-module') : p.testPair ? c.dim(' test pair') : '';
    out.push(`  ${c.yellow(lpad(p.degree + '%', 5))}  ${trunc(p.a, 40)} ${c.dim('⟷')} ${trunc(p.b, 40)} ${c.dim(`(${p.shared}×)`)}${tag}`);
  });
  out.push('');

  const isl = r.islands.slice(0, o.top);
  out.push(`  ${c.bold('KNOWLEDGE ISLANDS')} ${c.dim('— code that lives in one head.')}`);
  if (!isl.length) out.push(c.dim('  none — knowledge is well spread 👏'));
  isl.forEach(f => {
    const who = f.orphaned ? c.red(`${f.owner} (gone ${ago(f.ownerLastSeen)})`) : c.cyan(f.owner);
    out.push(`  ${lpad(f.share + '%', 5)}  ${pad(trunc(f.path, fileW - 6), fileW - 4)} ${who}`);
  });
  out.push('');

  if (r.heating.length) {
    out.push(`  ${c.bold('HEATING UP')} ${c.dim('— much more activity in the last 30 days than usual.')}`);
    r.heating.slice(0, Math.min(5, o.top)).forEach(f =>
      out.push(`  ${c.red(lpad('×' + f.heat, 6))}  ${pad(trunc(f.path, fileW), fileW)} ${c.dim(`${f.recent} commits this month`)}`));
    out.push('');
  }

  const bf = r.busFactor;
  const bfCol = bf <= 1 ? c.red : bf === 2 ? c.yellow : c.green;
  out.push(`  ${c.bold('BUS FACTOR')}  ${bfCol(c.bold(bf))} ${c.dim('—')} ${bf <= 1 ? 'if' : 'if these'} ${r.busAuthors.map(n => c.bold(n)).join(', ')} ${bf <= 1 ? 'leaves' : 'leave'}, more than half of the code loses its main author.`);
  out.push('');
  out.push(c.dim(`  --html for an interactive heat map · --md for a PR-ready report · --json for tooling`));
  out.push('');
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Markdown output                                                     */
/* ------------------------------------------------------------------ */

function renderMarkdown(r, o){
  const esc = s => String(s).replace(/\|/g, '\\|');
  const L = [];
  L.push(`## 🔥 git-heat · \`${r.repo}\``, '');
  L.push(`Since **${r.since}** · ${r.commits} commits · ${r.authors} authors · ${r.filesAnalysed} files · **bus factor ${r.busFactor}**`, '');
  L.push('### Hotspots', '', '| # | Heat | File | Revisions | Lines | Authors |', '|---:|---:|---|---:|---:|---:|');
  r.hotspots.slice(0, o.top).forEach((f, i) => L.push(`| ${i + 1} | ${f.score >= 70 ? '🔥' : f.score >= 40 ? '🟠' : '🟡'} ${f.score} | \`${esc(f.path)}\` | ${f.revisions} | ${f.loc} | ${f.authors} |`));
  L.push('');
  if (r.coupling.length) {
    L.push('### Hidden coupling', '', '| Together | Files | Shared commits |', '|---:|---|---:|');
    r.coupling.slice(0, o.top).forEach(p => L.push(`| ${p.degree}% | \`${esc(p.a)}\` ⟷ \`${esc(p.b)}\`${p.crossModule ? ' *(cross-module)*' : ''} | ${p.shared} |`));
    L.push('');
  }
  if (r.islands.length) {
    L.push('### Knowledge islands', '', '| Owner share | File | Owner |', '|---:|---|---|');
    r.islands.slice(0, o.top).forEach(f => L.push(`| ${f.share}% | \`${esc(f.path)}\` | ${esc(f.owner)}${f.orphaned ? ` ⚠️ inactive since ${ago(f.ownerLastSeen)}` : ''} |`));
    L.push('');
  }
  L.push(`<sub>Generated by git-heat ${r.version}</sub>`, '');
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* HTML report (self-contained, interactive treemap)                   */
/* ------------------------------------------------------------------ */

function renderHtml(r){
  const data = JSON.stringify({
    repo: r.repo, since: r.since, commits: r.commits, authors: r.authors, busFactor: r.busFactor, busAuthors: r.busAuthors,
    totalLoc: r.totalLoc, generatedAt: r.generatedAt,
    files: r.files.map(f => [f.path, f.loc, f.score, f.revisions, f.authors, f.mainAuthor || '', f.mainShare, f.lastTouch || 0]),
    coupling: r.coupling.slice(0, 30), islands: r.islands.slice(0, 30),
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>git-heat · ${escHtml(r.repo)}</title>
<style>
:root{--bg:#0d1117;--bg2:#161b22;--line:#30363d;--ink:#e6edf3;--mute:#8b949e}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:22px 24px 10px;display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline}
h1{font-size:22px}h1 span{color:var(--mute);font-weight:400}
.kpis{display:flex;flex-wrap:wrap;gap:18px;color:var(--mute)}.kpis b{color:var(--ink);font-size:16px}
#map{position:relative;margin:10px 24px;height:62vh;min-height:360px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--bg2)}
.cell{position:absolute;overflow:hidden;border:1px solid rgba(13,17,23,.85);font:11px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(255,255,255,.92);padding:3px 4px;cursor:default}
.cell:hover{outline:2px solid #fff;z-index:2}
.grp{position:absolute;pointer-events:none;border:2px solid rgba(13,17,23,1)}
.grp b{position:absolute;left:4px;top:2px;font:600 11px ui-monospace,monospace;color:#fff;text-shadow:0 1px 2px #000;background:rgba(13,17,23,.55);padding:0 4px;border-radius:3px}
#tip{position:fixed;pointer-events:none;background:#000d;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:12px/1.5 ui-monospace,monospace;display:none;z-index:9;max-width:420px}
.legend{display:flex;align-items:center;gap:8px;margin:0 24px;color:var(--mute);font-size:12px}
.legend i{display:inline-block;width:160px;height:10px;border-radius:5px;background:linear-gradient(90deg,#2b4a6b,#3a7d6b,#e3b341,#f0883e,#f85149)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));gap:18px;padding:18px 24px 40px}
section{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
h2{font-size:15px;margin-bottom:10px}h2 span{color:var(--mute);font-weight:400;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{padding:5px 6px;border-top:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--mute);font-weight:600;border-top:0}td.n{text-align:right;font-variant-numeric:tabular-nums}
code{font:12px ui-monospace,monospace;word-break:break-all}.warn{color:#f85149}.dim{color:var(--mute)}
footer{color:var(--mute);font-size:12px;text-align:center;padding-bottom:30px}footer a{color:var(--ink)}
</style></head><body>
<header><h1>🔥 git-heat <span>· ${escHtml(r.repo)}</span></h1><div class="kpis" id="kpis"></div></header>
<div class="legend">size = lines of code · color = hotspot score <i></i> cold → hot</div>
<div id="map"></div>
<div class="cols">
  <section><h2>Hotspots <span>complex + frequently changed</span></h2><table id="hot"></table></section>
  <section><h2>Hidden coupling <span>files that change together</span></h2><table id="coup"></table></section>
  <section><h2>Knowledge islands <span>one main author ≥ 80%</span></h2><table id="isl"></table></section>
</div>
<footer>Generated by <a href="https://github.com/CedricPoint/git-heat">git-heat</a> · <span id="gen"></span></footer>
<div id="tip"></div>
<script>
const D=${data};
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ago=t=>{if(!t)return'—';const d=(Date.now()/1e3-t)/86400;return d<1?'today':d<60?Math.round(d)+'d ago':d<730?Math.round(d/30)+'mo ago':(d/365).toFixed(1)+'y ago'};
$('kpis').innerHTML=[['commits',D.commits],['authors',D.authors],['files',D.files.length],['lines',D.totalLoc.toLocaleString('en')],['bus factor',D.busFactor]]
  .map(([k,v])=>'<span><b>'+v+'</b> '+k+'</span>').join('')+'<span>since '+esc(D.since)+'</span>';
$('gen').textContent=new Date(D.generatedAt).toLocaleString();
function heat(s){const st=[[0,[43,74,107]],[20,[58,125,107]],[45,[227,179,65]],[70,[240,136,62]],[100,[248,81,73]]];
  for(let i=1;i<st.length;i++)if(s<=st[i][0]){const[a,ca]=st[i-1],[b,cb]=st[i],t=(s-a)/(b-a);return'rgb('+ca.map((v,k)=>Math.round(v+(cb[k]-v)*t)).join(',')+')'}return'rgb(248,81,73)'}
// squarified treemap
function squarify(items,x,y,w,h){const out=[];const total=items.reduce((s,i)=>s+i.v,0);if(!total)return out;
  const scale=w*h/total;let rest=items.map(i=>({...i,a:i.v*scale}));
  while(rest.length){const short=Math.min(w,h);let row=[],best=Infinity;
    for(const it of rest){const r=[...row,it],s=r.reduce((a,b)=>a+b.a,0),mx=Math.max(...r.map(z=>z.a)),mn=Math.min(...r.map(z=>z.a));
      const worst=Math.max(short*short*mx/(s*s),(s*s)/(short*short*mn));if(worst>best)break;best=worst;row=r}
    const s=row.reduce((a,b)=>a+b.a,0);
    if(w>=h){const cw=s/h;let cy=y;for(const it of row){const ch=it.a/cw;out.push({...it,x,y:cy,w:cw,h:ch});cy+=ch}x+=cw;w-=cw}
    else{const ch=s/w;let cx=x;for(const it of row){const cw=it.a/ch;out.push({...it,x:cx,y,w:cw,h:ch});cx+=cw}y+=ch;h-=ch}
    rest=rest.slice(row.length)}return out}
function draw(){const m=$('map');m.innerHTML='';const W=m.clientWidth,H=m.clientHeight;
  const groups=new Map();for(const f of D.files){const g=f[0].includes('/')?f[0].split('/')[0]:'(root)';if(!groups.has(g))groups.set(g,[]);groups.get(g).push(f)}
  const gl=[...groups].map(([k,fs])=>({k,fs,v:fs.reduce((s,f)=>s+f[1],0)})).sort((a,b)=>b.v-a.v);
  for(const g of squarify(gl,0,0,W,H)){
    const items=g.fs.map(f=>({f,v:f[1]})).sort((a,b)=>b.v-a.v);
    for(const c of squarify(items,g.x,g.y,g.w,g.h)){const f=c.f,el=document.createElement('div');el.className='cell';
      el.style.cssText='left:'+c.x+'px;top:'+c.y+'px;width:'+c.w+'px;height:'+c.h+'px;background:'+heat(f[2]);
      if(c.w>60&&c.h>16)el.textContent=f[0].split('/').pop();
      el.onmousemove=e=>{const t=$('tip');t.style.display='block';t.style.left=Math.min(e.clientX+14,innerWidth-430)+'px';t.style.top=(e.clientY+14)+'px';
        t.innerHTML='<b>'+esc(f[0])+'</b><br>heat <b>'+f[2]+'</b> · '+f[3]+' revisions · '+f[1]+' lines<br>'+f[4]+' authors'+(f[5]?' · main: '+esc(f[5])+' ('+f[6]+'%)':'')+'<br>last change '+ago(f[7])};
      el.onmouseleave=()=>$('tip').style.display='none';m.appendChild(el)}
    const gb=document.createElement('div');gb.className='grp';gb.style.cssText='left:'+g.x+'px;top:'+g.y+'px;width:'+g.w+'px;height:'+g.h+'px';
    if(g.w>70&&g.h>30)gb.innerHTML='<b>'+esc(g.k)+'</b>';m.appendChild(gb)}}
draw();addEventListener('resize',()=>{clearTimeout(window._r);window._r=setTimeout(draw,150)});
const hot=D.files.filter(f=>f[3]>0).sort((a,b)=>b[2]-a[2]||b[3]-a[3]).slice(0,25);
$('hot').innerHTML='<tr><th>heat</th><th>file</th><th class="n">revs</th><th class="n">lines</th></tr>'+hot.map(f=>'<tr><td class="n" style="color:'+heat(f[2])+'"><b>'+f[2]+'</b></td><td><code>'+esc(f[0])+'</code></td><td class="n">'+f[3]+'</td><td class="n">'+f[1]+'</td></tr>').join('');
$('coup').innerHTML=D.coupling.length?'<tr><th class="n">together</th><th>files</th><th class="n">shared</th></tr>'+D.coupling.map(p=>'<tr><td class="n"><b>'+p.degree+'%</b></td><td><code>'+esc(p.a)+'</code><br><code>'+esc(p.b)+'</code>'+(p.crossModule?' <span class="warn">cross-module</span>':'')+'</td><td class="n">'+p.shared+'</td></tr>').join(''):'<tr><td class="dim">No strong coupling found.</td></tr>';
$('isl').innerHTML=D.islands.length?'<tr><th class="n">share</th><th>file</th><th>owner</th></tr>'+D.islands.map(f=>'<tr><td class="n">'+f.share+'%</td><td><code>'+esc(f.path)+'</code></td><td>'+esc(f.owner)+(f.orphaned?' <span class="warn">inactive '+ago(f.ownerLastSeen)+'</span>':'')+'</td></tr>').join(''):'<tr><td class="dim">Knowledge is well spread.</td></tr>';
</script></body></html>`;
}
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  const r = analyze(opts);
  if (opts.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else if (opts.md) process.stdout.write(renderMarkdown(r, opts));
  else process.stdout.write(renderTerminal(r, opts) + '\n');
  if (opts.html) {
    fs.writeFileSync(opts.html, renderHtml(r));
    if (!opts.json && !opts.md) process.stdout.write(`  🗺️  Heat map written to ${opts.html}\n\n`);
  }
}

module.exports = {parseRename, parseLog, whitespaceComplexity, globToRegExp, makeFilter, isCode, isTest, isBot, analyze, renderMarkdown, renderHtml};
