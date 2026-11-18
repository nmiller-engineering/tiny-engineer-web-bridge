#!/usr/bin/env node
/**
 * Build the extension into dist/.
 *
 *   node scripts/build.mjs           production build
 *   node scripts/build.mjs --watch   rebuild on change (npm run dev)
 *
 * Output is deterministic: no timestamps, no source maps, unminified (so
 * reviewers, e.g. Mozilla's, can read the shipped code).
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const entryPoints = {
  background: 'src/background/index.ts',
  'content/chatgpt': 'src/content/entry-chatgpt.ts',
  'content/claude': 'src/content/entry-claude.ts',
  'content/openwebui': 'src/content/entry-openwebui.ts',
  'popup/popup': 'src/popup/popup.ts',
  'options/options': 'src/options/options.ts',
};

const STATIC_FILES = ['shared/ui.css', 'popup/index.html', 'popup/popup.css', 'options/index.html', 'options/options.css', 'icons/icon.svg', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-96.png', 'icons/icon-128.png'];

/** esbuild options shared with tests/architecture.test.ts. */
export const buildOptions = {
  absWorkingDir: root,
  entryPoints,
  outdir: dist,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['firefox142'],
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
};

async function writeManifest() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(path.join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function copyStatic() {
  for (const file of STATIC_FILES) {
    await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
    await cp(path.join(src, file), path.join(dist, file));
  }
  await cp(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'));
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await copyStatic();
  await writeManifest();
  if (watch) {
    const ctx = await esbuild.context({
      ...buildOptions,
      plugins: [
        {
          name: 'static-files',
          setup(build) {
            build.onEnd(async () => {
              await copyStatic();
              await writeManifest();
            });
          },
        },
      ],
    });
    await ctx.watch();
    console.log('Watching for changes… load dist/manifest.json via about:debugging (or run `npm run start:firefox`).');
  } else {
    await esbuild.build(buildOptions);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
