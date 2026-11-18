/**
 * Claude (https://claude.ai) profile.
 *
 * VERIFICATION STATUS: NOT verified against the live site from this
 * repository's CI. Selectors reflect publicly observed claude.ai markup
 * (`data-is-streaming`, the ProseMirror composer, the "Stop response"
 * control) and may change at any time. See docs/DETECTION.md.
 */
import { DomDetector, type DomDetectorOptions, type PlatformProfile } from './base';

export const claudeProfile: PlatformProfile = {
  platform: 'claude',
  composer: ['[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]', 'fieldset [contenteditable="true"]'],
  stopButtons: ['button[data-testid="stop-button"]'],
  stopLabels: [{ scope: null, pattern: /^stop (response|generating)$/i }],
  generating: [],
  streaming: ['[data-is-streaming="true"]'],
  thinking: [],
  // No reliable, language-independent tool markers are known for claude.ai;
  // tool activity is reported as `thinking`/`responding` (see docs/DETECTION.md).
  tool: [],
  error: ['[data-testid="message-error"]'],
  response: ['[data-is-streaming]', '.font-claude-response', '.font-claude-message'],
};

export function createClaudeDetector(opts?: DomDetectorOptions): DomDetector {
  return new DomDetector(claudeProfile, opts);
}
