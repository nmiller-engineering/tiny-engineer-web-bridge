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
  // Verified via a live detection report (2026-11-19):
  // div[data-testid=assistant-message][data-is-streaming=true|false] > … > div.prose > div[data-alluvium] > p/ul/table
  response: ['[data-testid="assistant-message"]', '[data-is-streaming]', '.font-claude-response', '.font-claude-message'],
  // Assumed (not yet live-verified): user messages and the send control.
  userMessage: ['[data-testid="user-message"]'],
  sendButtons: ['button[aria-label^="send" i]', 'button[type="submit"]', 'fieldset button[data-testid*="send" i]'],
  // Verified container (2026-11-19): the streaming message is a list of
  // transcript items ([data-item-key]); text items contain div.prose.
  // Assumed: non-text items (thinking, tool calls) carry a short status header.
  blocks: {
    items: '[data-testid="assistant-message"][data-is-streaming="true"] [data-item-key]',
    text: '.prose',
    header: 'button, [aria-expanded], summary, [role="status"], [role="button"]',
  },
};

export function createClaudeDetector(opts?: DomDetectorOptions): DomDetector {
  return new DomDetector(claudeProfile, opts);
}
