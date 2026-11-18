/** Small helpers shared by the popup and options pages (privileged contexts only). */
import type { PageRequest } from './messaging';
import { PLATFORM_LABELS, type Platform } from './types';

export function sendToBackground<T>(request: PageRequest): Promise<T> {
  return browser.runtime.sendMessage(request) as Promise<T>;
}

export function $(selector: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}

export function $input(selector: string, root: ParentNode = document): HTMLInputElement {
  return $(selector, root) as HTMLInputElement;
}

export function formatAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export function platformLabel(p: Platform): string {
  return PLATFORM_LABELS[p];
}

export const STATE_LABELS: Record<string, string> = {
  idle: 'Idle',
  user_typing: 'User typing',
  thinking: 'Thinking',
  responding: 'Responding',
  tool_use: 'Using a tool',
  completed: 'Completed',
  error: 'Error',
  unknown: 'Unknown',
};

export const CONNECTION_LABELS: Record<string, string> = {
  unconfigured: 'Not set up',
  'no-permission': 'Access needed',
  unknown: 'Not checked yet',
  connected: 'Connected',
  disconnected: 'Unreachable',
  error: 'Error',
};

/** Colour tone for a connection state (matches .pill[data-tone]). */
export function connectionTone(connection: string): 'ok' | 'warn' | 'bad' | 'info' {
  switch (connection) {
    case 'connected':
      return 'ok';
    case 'unknown':
    case 'unconfigured':
      return 'info';
    case 'disconnected':
      return 'warn';
    default:
      return 'bad';
  }
}

/** Short confirmation bubble at the bottom of the page. */
export function toast(message: string): void {
  let el = document.querySelector<HTMLElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(setTimeout(() => el?.classList.remove('show'), 1600));
}

/** Replace children with plain text nodes / elements — never innerHTML. */
export function setText(el: HTMLElement, text: string): void {
  el.textContent = text;
}
