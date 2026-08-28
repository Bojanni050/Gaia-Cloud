'use strict';

/**
 * Version endpoint for Gaia Cloud.
 * 
 * Exposes build metadata generated at deployment time.
 * This is the authoritative source for Cloud version information.
 * 
 * Endpoint: GET /api/version
 * Response: {
 *   name: string,
 *   version: string,  // semantic version from package.json
 *   build: string     // YYYYMMDDHHmm format build identifier
 *   commit?: string   // optional git commit hash
 * }
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

// Load build metadata from the generated file
// This file is created at build time by scripts/generate-build-meta.js
function loadBuildMeta() {
  const metaPath = path.join(__dirname, '..', 'build-meta.json');
  
  try {
    const content = fs.readFileSync(metaPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    // Fallback for development when build-meta.json doesn't exist
    console.warn(`[version] Could not load build-meta.json: ${error.message}`);
    return {
      name: 'Gaia Cloud',
      version: '0.1.0',
      build: generateDevBuildId(),
      commit: null
    };
  }
}

// Generate a development build ID
function generateDevBuildId() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}-dev`;
}

// Cache the build metadata - this is fixed for the lifetime of the process
const buildMeta = loadBuildMeta();

function createVersionRouter() {
  const router = express.Router();

  /**
   * GET /api/version
   * Returns Cloud build metadata.
   * This is cached and does NOT regenerate on each request.
   */
  router.get('/version', (req, res) => {
    res.json({
      name: buildMeta.name,
      version: buildMeta.version,
      build: buildMeta.build,
      commit: buildMeta.commit
    });
  });

  return router;
}

module.exports = { createVersionRouter };
