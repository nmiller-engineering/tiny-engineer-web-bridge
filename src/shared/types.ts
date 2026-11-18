/**
 * Shared vocabulary for the whole extension.
 *
 * Everything here is plain data so it can be used by content scripts,
 * the background script, extension pages and tests alike.
 */

/** Normalized AI activity states reported by the detectors. */
export const AI_STATES = [
  'idle',
  'user_typing',
  'thinking',
  'responding',
  'tool_use',
  'completed',
  'error',
  'unknown',
] as const;
export type AIState = (typeof AI_STATES)[number];

/** States in which the AI is visibly working on a request. */
export const BUSY_STATES: ReadonlySet<AIState> = new Set(['thinking', 'responding', 'tool_use']);

/** Supported AI web interfaces. */
export const PLATFORMS = ['chatgpt', 'claude', 'openwebui'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  openwebui: 'C-3PO / Open WebUI',
};

/**
 * Animation names accepted by the Tiny Engineer firmware
 * (`POST /anim?name=…`, see upstream docs/api.md).
 */
export const ANIMATIONS = [
  'none',
  'typing',
  'reading',
  'thinking',
  'talking',
  'ring',
  'welcome',
  'attention',
  'error',
  'abort',
  'dead',
  'wakeup',
  'sleep',
] as const;
export type Animation = (typeof ANIMATIONS)[number];

/**
 * How an animation behaves on the robot, per upstream docs/api.md:
 * - `idle`: the rest pose (`none`).
 * - `continuous`: loops until replaced; firmware switches to `attention`
 *   after `continuous_timeout` minutes unless the same name is re-posted.
 * - `oneshot`: plays once and returns to `none` on its own.
 * - `hold`: plays, then holds a waiting loop (~1 min for attention/error,
 *   indefinitely for `dead`) before returning to `none`.
 */
export type AnimationKind = 'idle' | 'continuous' | 'oneshot' | 'hold';

export const ANIMATION_KIND: Record<Animation, AnimationKind> = {
  none: 'idle',
  typing: 'continuous',
  reading: 'continuous',
  thinking: 'continuous',
  talking: 'continuous',
  ring: 'oneshot',
  welcome: 'oneshot',
  abort: 'oneshot',
  wakeup: 'oneshot',
  sleep: 'oneshot',
  attention: 'hold',
  error: 'hold',
  dead: 'hold',
};

/** A mapping target: a firmware animation, or "do nothing for this state". */
export const DISABLED = 'disabled' as const;
export type MappingTarget = Animation | typeof DISABLED;
export type AnimationMapping = Record<AIState, MappingTarget>;

export type ArbitrationMode = 'active-tab' | 'activity-priority';

/**
 * Names of structural detection signals. Only these fixed identifiers are
 * ever reported from content scripts — never page text.
 */
export const SIGNAL_NAMES = [
  'composer',
  'stop-button',
  'generating-marker',
  'streaming-marker',
  'response-activity',
  'thinking-marker',
  'tool-marker',
  'error-marker',
  'user-input',
  'user-abort',
  'layout-unrecognized',
] as const;
export type SignalName = (typeof SIGNAL_NAMES)[number];

export interface DetectionSnapshot {
  state: AIState;
  /** 0…1, how sure the detector is about `state`. */
  confidence: number;
  /** Which structural signals contributed. */
  signals: SignalName[];
}

export function isAIState(value: unknown): value is AIState {
  return typeof value === 'string' && (AI_STATES as readonly string[]).includes(value);
}

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

export function isAnimation(value: unknown): value is Animation {
  return typeof value === 'string' && (ANIMATIONS as readonly string[]).includes(value);
}

export function isSignalName(value: unknown): value is SignalName {
  return typeof value === 'string' && (SIGNAL_NAMES as readonly string[]).includes(value);
}
