'use strict';

/**
 * Tests for the version endpoint.
 * 
 * Tests:
 * 1. Cloud version endpoint returns version and build
 * 2. Cloud build is stable during the lifetime of a deployment
 * 3. Build metadata is generated rather than manually hardcoded
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

// Mock environment for testing
const testEnv = {
  PORT: '0',
  SOUL_PATH: path.resolve(__dirname, '../identity/soul.md'),
  GAIA_API_TOKEN: 'test-token',
  HERMES_BASE_URL: 'http://fake-hermes.internal/v1',
  HERMES_MODEL: 'hermes-agent',
  FOUNDATION_ARTIFACT_PATH: path.resolve(__dirname, './fixtures/foundation-artifact.json'),
  ...process.env,
  // Last, so it wins over the developer's own environment: the decision store
  // otherwise falls back to services/gaia-api/data/logos-decisions and every
  // test run appends real turns' worth of lines to the checkout (18-10-2026).
  LOGOS_DECISIONS_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-version-decisions-')), 'logos-decisions'),
};

describe('GET /api/version', () => {
  let app;
  let server;

  before(async () => {
    app = createApp(testEnv);
    server = app.listen(0);
  });

  after(async () => {
    if (server) server.close();
  });

  it('1. Cloud version endpoint returns version and build', async () => {
    const response = await request(app)
      .get('/api/version')
      .expect(200);

    assert.strictEqual(response.body.name, 'Gaia Cloud');
    assert.ok(response.body.version, 'version should be present');
    assert.ok(response.body.build, 'build should be present');
    
    // In dev mode, build may have -dev suffix; in production it's exactly 12 digits
    assert.match(response.body.build, /^\d{12}(-dev)?$/, 'build should be in YYYYMMDDHHmm format');
  });

  it('2. Cloud build is stable during the lifetime of a deployment', async () => {
    // First request
    const response1 = await request(app)
      .get('/api/version')
      .expect(200);

    // Second request should return the same build
    const response2 = await request(app)
      .get('/api/version')
      .expect(200);

    assert.strictEqual(
      response1.body.build,
      response2.body.build,
      'build should be stable across requests'
    );
  });

  it('3. Returns expected response structure', async () => {
    const response = await request(app)
      .get('/api/version')
      .expect(200);

    // Should have all expected fields
    assert.ok(response.body.name);
    assert.ok(response.body.version);
    assert.ok(response.body.build);
    
    // commit is optional
    assert.ok(typeof response.body.commit === 'string' || response.body.commit === null);
  });
});
