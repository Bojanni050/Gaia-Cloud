#!/usr/bin/env node
'use strict';

/**
 * Builds foundation-artifact.json — the same { documents: {...} } shape
 * Gaia-Web's foundation/ build tool used to produce locally, now built
 * here in Gaia-Cloud (the owner of docs/ and identity/soul.md) and
 * published by CI for clients to pull, instead of clients vendoring their
 * own copies of docs/ and soul.md (docs/split-plan.md's stated direction).
 *
 * Document list and soul.md's identity-layer override are kept in sync
 * with what foundation/builder.ts + foundation/loader.ts used to encode
 * in Gaia-Web before this pipeline existed.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const SOUL_PATH = path.join(REPO_ROOT, 'services', 'gaia-api', 'identity', 'soul.md');
const OUTPUT_PATH = path.join(REPO_ROOT, 'foundation-artifact.json');

const DOCUMENTS = ['soul.md', 'principles.md', 'lexicon.md', 'identity.md', 'architecture.md', 'evolution.md'];

function loadDocument(filename) {
  const filePath = filename === 'soul.md' ? SOUL_PATH : path.join(DOCS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Could not find document at ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

function build() {
  const documents = {};
  for (const filename of DOCUMENTS) {
    documents[filename] = loadDocument(filename);
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify({ documents }, null, 2), 'utf-8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

build();
