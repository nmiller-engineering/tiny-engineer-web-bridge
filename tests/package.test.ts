import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain JS script module
import { createXpi } from '../scripts/package.mjs';

function makeTree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'te-xpi-'));
  mkdirSync(path.join(dir, 'popup'));
  writeFileSync(path.join(dir, 'manifest.json'), '{"name":"x"}');
  writeFileSync(path.join(dir, 'popup', 'popup.js'), 'console.log(1)'.repeat(50));
  writeFileSync(path.join(dir, 'background.js'), '"use strict";');
  return dir;
}

describe('XPI packaging', () => {
  it('is byte-for-byte reproducible regardless of file times', async () => {
    const a = makeTree();
    const b = makeTree();
    utimesSync(path.join(b, 'background.js'), new Date('2001-01-01'), new Date('2001-01-01'));
    const xa: Buffer = await createXpi(a);
    const xb: Buffer = await createXpi(b);
    expect(xa.equals(xb)).toBe(true);
  });

  it('produces a valid ZIP with manifest.json first and sorted entries', async () => {
    const xpi: Buffer = await createXpi(makeTree());
    expect(xpi.readUInt32LE(0)).toBe(0x04034b50);
    const names: string[] = [];
    let off = 0;
    while (xpi.readUInt32LE(off) === 0x04034b50) {
      const csize = xpi.readUInt32LE(off + 18);
      const nlen = xpi.readUInt16LE(off + 26);
      const name = xpi.subarray(off + 30, off + 30 + nlen).toString('utf8');
      const data = inflateRawSync(xpi.subarray(off + 30 + nlen, off + 30 + nlen + csize));
      if (name === 'manifest.json') expect(data.toString()).toBe('{"name":"x"}');
      names.push(name);
      off += 30 + nlen + csize;
    }
    expect(names).toEqual(['manifest.json', 'background.js', 'popup/popup.js']);
  });
});
