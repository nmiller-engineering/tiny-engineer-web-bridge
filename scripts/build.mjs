#!/usr/bin/env node
/**
 * Build the extension.
 *
 *   node scripts/build.mjs                    Firefox build → dist/
 *   node scripts/build.mjs --target=chrome    Chrome build  → dist-chrome/
 *   node scripts/build.mjs --watch            rebuild on change (npm run dev)
 *
 * One codebase, two targets. Differences are confined to the manifest, a
 * `__TARGET__` build constant and (Chrome only) the USB connection page.
 * Output is deterministic: no timestamps, no source maps, unminified (so
 * store reviewers can read the shipped code).
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');

export const TARGETS = {
  firefox: { outdir: path.join(root, 'dist'), esTarget: 'firefox142' },
  chrome: { outdir: path.join(root, 'dist-chrome'), esTarget: 'chrome120' },
};

const COMMON_ENTRIES = {
  background: 'src/background/index.ts',
  'content/chatgpt': 'src/content/entry-chatgpt.ts',
  'content/claude': 'src/content/entry-claude.ts',
  'content/openwebui': 'src/content/entry-openwebui.ts',
  'popup/popup': 'src/popup/popup.ts',
  'options/options': 'src/options/options.ts',
};

const COMMON_STATIC = [
  'shared/ui.css',
  'popup/index.html',
  'popup/popup.css',
  'options/index.html',
  'options/options.css',
  'icons/icon.svg',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-96.png',
  'icons/icon-128.png',
  'icons/icon-off-16.png',
  'icons/icon-off-32.png',
];

function entriesFor(target) {
  // Chrome's service worker cannot use Web Serial, so a page holds the USB connection.
  return target === 'chrome' ? { ...COMMON_ENTRIES, 'usb/usb': 'src/usb/usb.ts' } : COMMON_ENTRIES;
}

function staticFor(target) {
  return target === 'chrome' ? [...COMMON_STATIC, 'usb/index.html', 'usb/usb.css'] : COMMON_STATIC;
}

/** esbuild options for a target (also used by tests/architecture.test.ts). */
export function buildOptionsFor(target = 'firefox') {
  const t = TARGETS[target];
  return {
    absWorkingDir: root,
    entryPoints: entriesFor(target),
    outdir: t.outdir,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: [t.esTarget],
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'info',
    define: { __TARGET__: JSON.stringify(target) },
    // Chrome ≥ 120 has promise-based `chrome.*`; newer versions also expose `browser`.
    banner: target === 'chrome' ? { js: 'globalThis.browser ??= globalThis.chrome;' } : undefined,
  };
}

/** Back-compat export: the Firefox build options. */
export const buildOptions = buildOptionsFor('firefox');

/** Derive the Chrome manifest from the (Firefox) source manifest. */
export function chromeManifest(manifest) {
  const m = structuredClone(manifest);
  delete m.browser_specific_settings; // Gecko-only (id, data_collection_permissions)
  delete m.author; // Chrome expects an object here; not needed
  m.background = { service_worker: 'background.js' };
  m.minimum_chrome_version = '120';
  return m;
}

async function writeManifest(target) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  let manifest = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  if (target === 'chrome') manifest = chromeManifest(manifest);
  await writeFile(path.join(TARGETS[target].outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function copyStatic(target) {
  const out = TARGETS[target].outdir;
  for (const file of staticFor(target)) {
    await mkdir(path.dirname(path.join(out, file)), { recursive: true });
    await cp(path.join(src, file), path.join(out, file));
  }
  await cp(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
}

export async function build(target = 'firefox', { watch = false } = {}) {
  if (!TARGETS[target]) throw new Error(`Unknown target "${target}" (use firefox or chrome)`);
  const out = TARGETS[target].outdir;
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await copyStatic(target);
  await writeManifest(target);
  const options = buildOptionsFor(target);
  if (watch) {
    const ctx = await esbuild.context({
      ...options,
      plugins: [
        {
          name: 'static-files',
          setup(b) {
            b.onEnd(async () => {
              await copyStatic(target);
              await writeManifest(target);
            });
          },
        },
      ],
    });
    await ctx.watch();
    console.log(`Watching for changes (${target})… output in ${path.relative(root, out)}/`);
  } else {
    await esbuild.build(options);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv.find((a) => a.startsWith('--target='));
  build(arg ? arg.slice('--target='.length) : 'firefox', { watch: process.argv.includes('--watch') }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
