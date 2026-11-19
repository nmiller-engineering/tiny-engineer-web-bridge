/**
 * Which browser this bundle was built for (set by scripts/build.mjs).
 * Defaults to Firefox when the constant is not defined (unit tests).
 */
declare const __TARGET__: 'firefox' | 'chrome';

export type BuildTarget = 'firefox' | 'chrome';

export const TARGET: BuildTarget = typeof __TARGET__ !== 'undefined' ? __TARGET__ : 'firefox';
