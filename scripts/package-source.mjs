#!/usr/bin/env node
/**
 * Reproducible source archive for Mozilla add-on review (AMO asks for the
 * sources of bundled code). Contains every git-tracked file except docs
 * screenshots, so reviewers can run `npm ci && npm run build` and compare.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && !f.startsWith('docs/screenshots/'))
  .sort();
const epoch = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) : 315532800;
const zip = await createZip(root, files, epoch);
const outDir = path.join(root, 'web-ext-artifacts');
await mkdir(outDir, { recursive: true });
const out = path.join(outDir, `tiny-engineer-web-bridge-${pkg.version}-source.zip`);
await writeFile(out, zip);
console.log(`${path.relative(root, out)}  ${files.length} files, ${zip.length} bytes`);
console.log(`sha256 ${createHash('sha256').update(zip).digest('hex')}`);
