#!/usr/bin/env node
'use strict';

/**
 * Generates build-meta.json at build/deployment time.
 * 
 * This script must be run during the build process (Docker build or CI)
 * to capture the actual build timestamp. The generated file is then
 * bundled with the deployment artifact.
 * 
 * Format: YYYYMMDDHHmm (UTC)
 * Example: 202608282334
 */

const fs = require('fs');
const path = require('path');

// Read version from package.json
const packageJson = require('../package.json');

// Generate build timestamp in YYYYMMDDHHmm format (UTC)
function generateBuildId() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}`;
}

// Check for existing git commit (optional, for debugging)
function getGitCommit() {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --short HEAD', { 
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8'
    }).trim();
  } catch {
    return null;
  }
}

const buildMeta = {
  name: 'Gaia Cloud',
  version: packageJson.version,
  build: generateBuildId(),
  commit: getGitCommit(),
  generatedAt: new Date().toISOString()
};

const outputPath = path.join(__dirname, '..', 'build-meta.json');
fs.writeFileSync(outputPath, JSON.stringify(buildMeta, null, 2), 'utf-8');

console.log(`Generated build metadata: ${outputPath}`);
console.log(JSON.stringify(buildMeta, null, 2));
