import { describe, expect, it } from 'vitest';
import { classifyLabelText } from '../src/detectors/labels';

describe('status label classification', () => {
  it.each([
    ['Thinking…', 'thinking'],
    ['  Thought for 12s', 'thinking'],
    ['Reasoning', 'thinking'],
    ['Denkt nach…', 'thinking'],
    ['Searching the web', 'tool'],
    ['Searched 12 sites', 'tool'],
    ['Running command', 'tool'],
    ['Ran 3 commands', 'tool'],
    ['Creating file report.md', 'tool'],
    ['Reading file', 'tool'],
    ['Fetching https://example.com', 'tool'],
    ['Used Google Drive', 'tool'],
    ['Durchsucht das Web', 'tool'],
    ['Befehl ausgeführt', 'other'],
    ['Artifact', 'other'],
  ])('%s → %s', (label, category) => {
    expect(classifyLabelText(label)).toBe(category);
  });

  it('ignores empty and long text (never classifies prose)', () => {
    expect(classifyLabelText('')).toBeNull();
    expect(classifyLabelText('   ')).toBeNull();
    expect(classifyLabelText(`Thinking about ${'a very long answer '.repeat(10)}`)).toBeNull();
  });
});
