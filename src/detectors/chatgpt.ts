/**
 * ChatGPT (https://chatgpt.com) profile.
 *
 * VERIFICATION STATUS: not verified from this repository's CI. Selectors are
 * cross-checked against the actively maintained open-source library
 * chatgpt.js (KudoAI, MIT; src/chatgpt.js `selectors`, commit 43f377e,
 * 2026-08-10), which decides "ChatGPT is typing" by the stop button alone:
 *   btns.stop      button[data-testid=stop-button]
 *   btns.send      button[data-testid=send-button]
 *   chatDivs.reply li[data-message-role=assistant], div[data-message-author-role=assistant]
 *   chatDivs.msg   li[data-message-role], div[data-message-author-role]
 *   errors.txt     div[class*=text-error]
 *   getChatBox()   #prompt-textarea
 * See docs/DETECTION.md and docs/MANUAL_TESTING.md.
 */
import { DomDetector, type DomDetectorOptions, type PlatformProfile } from './base';

export const chatgptProfile: PlatformProfile = {
  platform: 'chatgpt',
  composer: ['#prompt-textarea', '[data-testid="prompt-textarea"]', 'form [contenteditable="true"]', 'form textarea'],
  stopButtons: ['button[data-testid="stop-button"]', 'form button[data-testid*="stop" i]'],
  // Inside the prompt form any "Stop…" label is the stop control; elsewhere
  // only explicit wording (read-aloud also uses a bare "Stop").
  stopLabels: [
    { scope: 'form', pattern: /^stop\b/i },
    { scope: null, pattern: /^stop (streaming|generating|answering|response)$/i },
  ],
  generating: [],
  streaming: ['[data-message-author-role="assistant"] .result-streaming', '.result-streaming'],
  thinking: [],
  // No reliable, language-independent tool markers are known for ChatGPT;
  // tool activity is reported as `thinking` (see docs/DETECTION.md).
  tool: [],
  error: ['[data-testid="error-message"]', 'div[class*="text-error"]'],
  // Newer ChatGPT renders turns as list items (li[data-message-role=…]); older as divs.
  response: ['li[data-message-role="assistant"]', '[data-message-author-role="assistant"]', 'article[data-turn="assistant"]'],
  userMessage: ['li[data-message-role="user"]', '[data-message-author-role="user"]'],
  sendButtons: ['button[data-testid="send-button"]', 'button[aria-label^="send" i]'],
};

export function createChatGPTDetector(opts?: DomDetectorOptions): DomDetector {
  return new DomDetector(chatgptProfile, opts);
}
