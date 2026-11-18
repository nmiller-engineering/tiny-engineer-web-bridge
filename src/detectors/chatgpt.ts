/**
 * ChatGPT (https://chatgpt.com) profile.
 *
 * VERIFICATION STATUS: NOT verified against the live site from this
 * repository's CI. Selectors reflect publicly observed ChatGPT markup
 * (data-testid / data-message-author-role attributes) and may change at any
 * time. See docs/DETECTION.md and docs/MANUAL_TESTING.md.
 */
import { DomDetector, type DomDetectorOptions, type PlatformProfile } from './base';

export const chatgptProfile: PlatformProfile = {
  platform: 'chatgpt',
  composer: ['#prompt-textarea', '[data-testid="prompt-textarea"]', 'form [contenteditable="true"]', 'form textarea'],
  stopButtons: ['button[data-testid="stop-button"]'],
  // English UI fallback. Deliberately not a bare "Stop": read-aloud uses that.
  stopLabels: [{ scope: null, pattern: /^stop (streaming|generating)$/i }],
  generating: [],
  streaming: ['[data-message-author-role="assistant"] .result-streaming', '.result-streaming'],
  thinking: [],
  // No reliable, language-independent tool markers are known for ChatGPT;
  // tool activity is reported as `thinking` (see docs/DETECTION.md).
  tool: [],
  error: ['[data-testid="error-message"]', '.text-token-text-error'],
  response: ['[data-message-author-role="assistant"]'],
};

export function createChatGPTDetector(opts?: DomDetectorOptions): DomDetector {
  return new DomDetector(chatgptProfile, opts);
}
