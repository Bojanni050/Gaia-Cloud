'use strict';

// Guards the migration-ordering contract of src/db/migrate.js:
//
//   1. It applies every .sql file in ./migrations in FILENAME order, so the
//      numeric prefix IS the order — a new file that reuses an existing number
//      can silently change what runs after what.
//   2. It records the FULL FILENAME in schema_migrations, so renaming an
//      already-applied migration makes it apply AGAIN on every existing
//      database (this is a live Postgres store, not a test fixture).
//
// Hence: unique ascending numbers for new migrations, and the one historical
// duplicate — `010` — is left exactly as it is. Its header explains why.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');

// number → the filenames allowed to share it. Exactly one entry, and only
// because both files were applied as 010_ on every existing store already.
const ALLOWED_DUPLICATES = {
  '010': ['010_hypothesis_correction.sql', '010_normalize_sources_prefix.sql'],
};

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

test('every migration is named NNN_description.sql', () => {
  const files = migrationFiles();
  assert.ok(files.length > 0, 'no migrations found — wrong directory?');
  for (const file of files) {
    assert.match(file, /^\d{3}_[a-z0-9_]+\.sql$/, `${file} must be named NNN_description.sql`);
  }
});

test('no two migrations share a number, except the documented historical pair', () => {
  const byNumber = new Map();
  for (const file of migrationFiles()) {
    const number = file.slice(0, 3);
    byNumber.set(number, [...(byNumber.get(number) || []), file]);
  }
  for (const [number, files] of byNumber) {
    if (files.length === 1) continue;
    assert.deepEqual(
      files.slice().sort(),
      ALLOWED_DUPLICATES[number],
      `${files.join(', ')} all use ${number}; only the historical pair may share a number, and a new migration takes the next free number`,
    );
  }
});

test('the historical pair is still intact — renaming one would re-apply it', () => {
  const files = migrationFiles();
  for (const [number, names] of Object.entries(ALLOWED_DUPLICATES)) {
    assert.deepEqual(
      names.filter((name) => files.includes(name)),
      names,
      `one of the ${number}_ migrations was renamed or deleted: schema_migrations records filenames, so the new name applies again on every existing database. Read the file header and update this test deliberately if that is really intended.`,
    );
  }
});
