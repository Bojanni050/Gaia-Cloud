#!/usr/bin/env node
'use strict';

/**
 * verify-architecture.js — the drift guard for docs/architecture.md.
 *
 * The document names paths, environment flags, routes, capability ids, tool
 * names and lifecycle statuses that exist in this repo. Nothing checked them, so
 * when the code moved the prose kept reading just as confidently: that is how
 * the 2026-11-11 audit ended up with eighteen stale claims (docs/advice.md §1).
 *
 * This script reads the anchors *out of the document* and fails when one of them
 * is gone from the tree. It is deliberately a grep, not a parser: an anchor that
 * vanished is a red build, and a false alarm is fixed by wording the claim
 * better or by marking it *(external)* / *(deployment)* — the document's own
 * escape hatch, which this script honours.
 *
 *   node scripts/verify-architecture.js
 *
 * Exit 0: every anchor found. Exit 1: at least one anchor is gone (listed).
 * No dependencies. Reads only; never writes.
 */

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist', 'build']);
const EXEMPT = /\((external|deployment)\)/;
// Absolute paths that are host or container paths by construction. They cannot
// be checked from this repo; the document marks them *(deployment)* as well.
const HOST_PATHS = ['/root/', '/opt/', '/app/', '/var/', '/etc/', '/usr/'];
const ROOT_DIRS = /^(services|docs|scripts|proxy|memory|\.github)\/[\w./@+-]+$/;
const FLAG_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const IDENT_RE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;

/** Every `backticked` span in a block of text, trimmed and de-duplicated. */
function backticked(text) {
  const spans = [];
  const re = /`([^`\n]+)`/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const token = match[1].trim();
    if (token) spans.push(token);
  }
  return [...new Set(spans)];
}

/** The document as heading-delimited sections (## and ###), with line numbers. */
function sections(text) {
  const lines = text.split('\n');
  const found = [];
  let current = { title: '(preamble)', line: 1, body: [] };
  lines.forEach((line, index) => {
    const heading = /^#{2,3}\s+(.*)$/.exec(line);
    if (heading) {
      found.push(current);
      current = { title: heading[1].trim(), line: index + 1, body: [] };
    } else {
      current.body.push({ text: line, line: index + 1 });
    }
  });
  found.push(current);
  return found;
}

/** `{a,b}` in a route is shorthand: expand it into the routes a client sees. */
function expandRoute(route) {
  const brace = /\{([^{}]+)\}/.exec(route);
  if (!brace || !brace[1].includes(',')) return [route];
  return brace[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => expandRoute(`${route.slice(0, brace.index)}${part}${route.slice(brace.index + brace[0].length)}`));
}

/** All files under `dir` whose name matches `test`, as repo-relative paths. */
function walk(dir, test, root, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), test, root, out);
    } else if (test(entry.name)) {
      out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

/** One searchable blob per code area, so a check is a substring test. */
function buildIndex(root) {
  const files = [
    ...walk(path.join(root, 'services'), (n) => /\.(js|json|sql)$|\.env\.example$/.test(n), root),
    ...walk(path.join(root, 'scripts'), (n) => n.endsWith('.js'), root),
  ];
  const byFile = new Map();
  for (const file of files) {
    byFile.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
  }
  const join = (predicate) => [...byFile]
    .filter(([file]) => predicate(file))
    .map(([, text]) => text)
    .join('\n');
  return {
    files: byFile.size,
    all: join(() => true),
    gaiaApiSrc: join((f) => f.startsWith('services/gaia-api/src/')),
    cognitionSrc: join((f) => f.startsWith('services/cognition/src/')),
    cognitionMigrations: join((f) => f.startsWith('services/cognition/src/db/migrations/')),
  };
}

/**
 * Does this route still exist? The document writes them as a client sees them
 * (`POST /eleos/checkins/:id/ack`), while the code declares them per router
 * (`/checkins/:id/ack`), so the check walks the tails from longest to shortest
 * and accepts the first that is a literal in the source.
 */
/**
 * Every diagram in a file, in document order. The markdown and the standalone
 * page keep the same pictures in the same order — that is the whole point of
 * the comparison in check 6.
 */
function diagramsIn(text, pattern) {
  return [...text.matchAll(pattern)].map((m) => m[1].trim());
}

function routePresent(route, haystack) {
  const cleaned = route.replace(/\{([^}]+)\}/g, ':$1').replace(/\/+$/, '');
  const segments = cleaned.split('/').filter(Boolean);
  for (let start = 1; start < segments.length; start += 1) {
    const tail = `/${segments.slice(start).join('/')}`;
    if (haystack.includes(`'${tail}'`) || haystack.includes(`"${tail}"`) || haystack.includes(`\`${tail}\``)) {
      return true;
    }
  }
  const last = segments[segments.length - 1];
  return Boolean(last) && new RegExp(`['"\`/]${last.replace(/[:.]/g, '\\$&')}['"\`/,]`).test(haystack);
}

function anchorPresent(token, haystack) {
  return new RegExp(`(^|[^A-Za-z0-9_])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`).test(haystack);
}

/**
 * @param {{ root?: string, docPath?: string }} [options]
 * @returns {{ ok: boolean, failures: Array<object>, checked: object, docCommit: string|null, head: string|null }}
 */
function verify({ root = path.join(__dirname, '..'), docPath = 'docs/architecture.md' } = {}) {
  const text = fs.readFileSync(path.join(root, docPath), 'utf8').replace(/\r\n/g, '\n');
  const index = buildIndex(root);
  const failures = [];
  const checked = { paths: 0, flags: 0, identifiers: 0, statuses: 0, routes: 0 };

  const addFailure = (kind, token, line, detail) => {
    failures.push({ kind, token, line, detail });
  };

  // 1. Paths that name a repo-root directory must exist.
  for (const section of sections(text)) {
    for (const { text: line, line: number } of section.body) {
      if (EXEMPT.test(line)) continue;
      for (const token of backticked(line)) {
        if (!ROOT_DIRS.test(token)) continue;
        checked.paths += 1;
        if (!fs.existsSync(path.join(root, token))) {
          addFailure('path', token, number, `${token} is named here but is not in the tree`);
        }
      }
    }
  }

  // 2. Environment flags must still be read somewhere in the code.
  for (const section of sections(text)) {
    for (const { text: line, line: number } of section.body) {
      if (EXEMPT.test(line)) continue;
      for (const token of backticked(line)) {
        if (!FLAG_RE.test(token)) continue;
        checked.flags += 1;
        if (!anchorPresent(token, index.all)) {
          addFailure('flag', token, number, `${token} is documented here but no longer read in the code`);
        }
      }
    }
  }

  // 3. The vocabulary section names tools, capability ids and skills — all of
  //    which live in gaia-api, so a rename there must show up here.
  const vocabulary = sections(text).find((s) => s.title === 'Tool, capability, skill');
  if (vocabulary) {
    for (const { text: line, line: number } of vocabulary.body) {
      for (const token of backticked(line)) {
        if (!IDENT_RE.test(token) || token.length < 3) continue;
        if (token.includes(':') || token.includes('.')) continue;
        checked.identifiers += 1;
        if (!anchorPresent(token, index.gaiaApiSrc)) {
          addFailure('identifier', token, number, `${token} is named here but not in services/gaia-api/src`);
        }
      }
    }
  }

  // 4. The lifecycle section's statuses and columns live in the store.
  const lifecycle = sections(text).find((s) => s.title === 'Derived lifecycle');
  if (lifecycle) {
    for (const { text: line, line: number } of lifecycle.body) {
      for (const token of backticked(line)) {
        if (!IDENT_RE.test(token) || token.length < 3) continue;
        checked.statuses += 1;
        if (!anchorPresent(token, index.cognitionSrc)) {
          addFailure('status', token, number, `${token} is named in the lifecycle but not in services/cognition/src`);
        }
      }
    }
  }

  // 5. Paths that a client or operator reaches must still be declared — with or
  //    without an HTTP method in front of them (the mounts and the parenthetical
  //    routes in that section carry no method). Absolute host/container paths
  //    are skipped by construction: this repo cannot check a VPS path, which is
  //    exactly what the document's *(deployment)* marker is for.
  const surface = sections(text).find((s) => s.title === 'HTTP surface');
  if (surface) {
    for (const { text: line, line: number } of surface.body) {
      if (EXEMPT.test(line)) continue;
      const withMethod = [...line.matchAll(/\b(?:GET|POST|PATCH|DELETE|PUT)\s+(\/[\w:{}.,/*-]*)/g)].map((m) => m[1]);
      const bare = backticked(line).filter((token) => /^\/[\w:{}.,*/-]+$/.test(token));
      for (const route of [...withMethod, ...bare].flatMap((r) => expandRoute(r))) {
        const cleaned = route.replace(/\/\*$/, '').replace(/\/+$/, '').replace(/,+$/, '');
        if (!cleaned || cleaned === '/') continue;
        if (HOST_PATHS.some((prefix) => cleaned.startsWith(prefix))) continue;
        checked.routes += 1;
        if (!routePresent(cleaned, index.cognitionSrc) && !routePresent(cleaned, index.gaiaApiSrc)) {
          addFailure('route', cleaned, number, `${cleaned} is documented here but no handler declares it`);
        }
      }
    }
  }

  const docCommit = /Verified against code: commit `([0-9a-f]{7,40})`/.exec(text);

  // 6. The visual map has a standalone twin. Both render the same diagrams, so
  //    two copies of one picture drift apart silently — which is how the map
  //    ended up describing a system that no longer existed. A lone half is a
  //    failure too: an .html without its .md is a page nobody can check.
  const graphFiles = ['docs/architecture-graph.md', 'docs/architecture-graph.html'];
  const present = graphFiles.filter((rel) => fs.existsSync(path.join(root, rel)));
  if (present.length) {
    const missing = graphFiles.filter((rel) => !present.includes(rel));
    if (missing.length) {
      addFailure('graph', missing[0], 0, `${missing[0]} is missing while its twin is present`);
    } else {
      const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
      const mdDiagrams = diagramsIn(read(graphFiles[0]), /```mermaid\n([\s\S]*?)```/g);
      const htmlDiagrams = diagramsIn(read(graphFiles[1]), /<pre class="mermaid">\n([\s\S]*?)<\/pre>/g);
      checked.diagrams = mdDiagrams.length;
      if (mdDiagrams.length !== htmlDiagrams.length) {
        addFailure('graph', graphFiles[1], 0,
          `${graphFiles[0]} carries ${mdDiagrams.length} diagrams, ${graphFiles[1]} carries ${htmlDiagrams.length}`);
      }
      const pairs = Math.min(mdDiagrams.length, htmlDiagrams.length);
      for (let i = 0; i < pairs; i += 1) {
        if (mdDiagrams[i] !== htmlDiagrams[i]) {
          addFailure('graph', `${graphFiles[1]} #${i + 1}`, 0,
            `diagram ${i + 1} differs from the same diagram in ${graphFiles[0]}`);
        }
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    checked,
    docCommit: docCommit ? docCommit[1] : null,
    head: null,
  };
}

function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const result = verify({
    root: path.resolve(option('root', path.join(__dirname, '..'))),
    docPath: option('doc', 'docs/architecture.md'),
  });
  const { checked } = result;
  console.log(
    `verify-architecture: ${checked.paths} paths, ${checked.flags} flags, `
    + `${checked.identifiers} capability/tool names, ${checked.statuses} lifecycle terms, `
    + `${checked.routes} routes checked against the tree, `
    + `${checked.diagrams ?? 0} diagrams checked against their twin`,
  );
  if (result.ok) {
    console.log(`ok — every anchor in docs/architecture.md exists (doc verified against ${result.docCommit || 'an unrecorded commit'})`);
    process.exit(0);
  }
  console.error(`FAILED — ${result.failures.length} anchor(s) no longer exist:`);
  for (const failure of result.failures) {
    console.error(`  docs/architecture.md:${failure.line}  [${failure.kind}] ${failure.detail}`);
  }
  console.error('\nEither fix the document, or mark the claim *(external)* / *(deployment)* if this repo cannot check it.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { verify, sections, backticked, routePresent };
