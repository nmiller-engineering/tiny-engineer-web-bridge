/**
 * Open WebUI profile (any self-hosted instance; the origin is user-configured).
 *
 * VERIFICATION STATUS: selectors were derived from the Open WebUI source
 * (src/lib/components/chat/MessageInput.svelte, Messages/ResponseMessage.svelte,
 * Messages/ResponseMessage/StatusHistory/StatusItem.svelte at upstream commit
 * 0666e59, 2026-11-17). They have not been exercised against a running
 * instance from CI. Older/newer Open WebUI versions may differ.
 *
 *  - `#chat-input`                      prompt editor (id={inputId}, default 'chat-input')
 *  - `#message-input-container`         composer wrapper
 *  - button[aria-label="Stop"]          stop control, only rendered while a response is active
 *                                       (label is i18n'd → English fallback only)
 *  - .animate-cursor-pulse in #response-content-container
 *                                       caret shown while `!message.done && !message.error`
 *  - .status-description .shimmer       in-progress status (web search, tools, …)
 *  - [data-sonner-toast][data-type="error"]
 *                                       error toasts (svelte-sonner)
 */
import { DomDetector, type DomDetectorOptions, type PlatformProfile } from './base';

export const openwebuiProfile: PlatformProfile = {
  platform: 'openwebui',
  composer: ['#chat-input', '[data-composer-id="chat-input"] [contenteditable="true"]', '#message-input-container textarea'],
  stopButtons: [],
  stopLabels: [{ scope: '#message-input-container', pattern: /^stop$/i }],
  generating: ['#response-content-container .animate-cursor-pulse'],
  streaming: [],
  thinking: [],
  tool: ['.status-description .shimmer'],
  error: ['[data-sonner-toast][data-type="error"]'],
  response: ['#response-content-container'],
  // UserMessage.svelte: class="flex w-full user-message group …"
  userMessage: ['.user-message'],
  sendButtons: ['#send-message-button'],
};

export function createOpenWebUIDetector(opts?: DomDetectorOptions): DomDetector {
  return new DomDetector(openwebuiProfile, opts);
}
