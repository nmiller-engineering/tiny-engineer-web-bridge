/**
 * Structural guarantees of the build: content scripts cannot reach storage,
 * the network or the device client; the manifest asks for minimal permissions.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');

async function bundle(entry: string) {
  const res = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['firefox142'],
    metafile: true,
    logLevel: 'silent',
  });
  return { code: res.outputFiles[0]!.text, inputs: Object.keys(res.metafile.inputs) };
}

describe('content-script bundles', () => {
  for (const p of ['chatgpt', 'claude', 'openwebui']) {
    it(`${p}: no config, storage, device client or network APIs`, async () => {
      const { code, inputs } = await bundle(`src/content/entry-${p}.ts`);
      expect(inputs.filter((i) => /background\/|shared\/(config|storage)/.test(i))).toEqual([]);
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/XMLHttpRequest|WebSocket|sendBeacon|navigator\.serial/);
      expect(code).not.toMatch(/browser\.storage|chrome\.storage/);
      expect(code).not.toMatch(/\.innerText|\.innerHTML|\.outerHTML/);
    });
  }
});

describe('text access in content scripts', () => {
  it('only src/detectors/labels.ts reads on-screen text', async () => {
    const { readdirSync } = await import('node:fs');
    const offenders: string[] = [];
    for (const dir of ['src/content', 'src/detectors']) {
      for (const f of readdirSync(path.join(root, dir))) {
        const rel = `${dir}/${f}`;
        if (rel === 'src/detectors/labels.ts') continue;
        const src = readFileSync(path.join(root, rel), 'utf8');
        if (/\.textContent|\.innerText|\.value\b/.test(src)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('labels.ts only exports categories and booleans, never text', () => {
    const src = readFileSync(path.join(root, 'src/detectors/labels.ts'), 'utf8');
    const exportedFns = [...src.matchAll(/export function (\w+)\([^)]*\): ([^{]+)\{/g)].map((m) => `${m[1]}: ${m[2]!.trim()}`);
    expect(exportedFns).toEqual([
      'classifyLabelText: BlockCategory | null',
      'classifyStatusLabel: BlockCategory | null',
      'hasDraft: boolean',
    ]);
  });
});

describe('Chrome build', () => {
  it('derives a valid MV3 Chrome manifest', async () => {
    // @ts-expect-error — plain JS build module
    const { chromeManifest } = await import('../scripts/build.mjs');
    const m = chromeManifest(JSON.parse(readFileSync(path.join(root, 'src/manifest.json'), 'utf8')));
    expect(m.background).toEqual({ service_worker: 'background.js' });
    expect(m.browser_specific_settings).toBeUndefined();
    expect(m.minimum_chrome_version).toBe('120');
    expect(m.permissions.sort()).toEqual(['alarms', 'contextMenus', 'scripting', 'storage']);
    expect(m.host_permissions).toEqual(['https://chatgpt.com/*', 'https://claude.ai/*']);
  });

  for (const p of ['chatgpt', 'claude', 'openwebui']) {
    it(`${p}: Chrome content bundle has no config, storage or network access either`, async () => {
      // @ts-expect-error — plain JS build module
      const { buildOptionsFor } = await import('../scripts/build.mjs');
      const opts = buildOptionsFor('chrome');
      const res = await esbuild.build({ ...opts, entryPoints: [`src/content/entry-${p}.ts`], outdir: undefined, write: false, metafile: true, logLevel: 'silent' });
      const code = res.outputFiles![0]!.text;
      expect(Object.keys(res.metafile!.inputs).filter((i) => /background\/|shared\/(config|storage)/.test(i))).toEqual([]);
      expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|navigator\.serial|browser\.storage|chrome\.storage/);
    });
  }
});

describe('manifest', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'src/manifest.json'), 'utf8'));

  it('uses MV3 with minimal permissions', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions.sort()).toEqual(['alarms', 'contextMenus', 'scripting', 'storage']);
    expect(manifest.host_permissions).toEqual(['https://chatgpt.com/*', 'https://claude.ai/*']);
    expect(manifest.permissions).not.toContain('<all_urls>');
    expect(manifest.commands['toggle-bridge'].suggested_key.default).toBe('Alt+Shift+R');
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(manifest.content_scripts).toBeUndefined(); // registered dynamically per enabled platform
  });

  it('declares no data collection and a strict CSP', () => {
    expect(manifest.browser_specific_settings.gecko.data_collection_permissions).toEqual({ required: ['none'] });
    const csp: string = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|https?:\/\/[a-z]/);
  });
});

describe('release assets', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'src/manifest.json'), 'utf8'));

  it('references icons that exist, including the 128 px listing icon', () => {
    const icons: Record<string, string> = { ...manifest.icons, ...manifest.action.default_icon };
    expect(Object.keys(manifest.icons)).toContain('128');
    for (const file of Object.values(icons)) expect(() => readFileSync(path.join(root, 'src', file))).not.toThrow();
  });

  it('documents the current version in the changelog', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')).toContain(`## [${pkg.version}]`);
  });
});
