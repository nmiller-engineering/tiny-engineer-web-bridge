/**
 * Opt-in debug log. In memory only (lost when the background unloads),
 * capped, and only ever fed with states, platform names, tab ids, animation
 * names and error categories — never page content, URLs with secrets,
 * tokens or message bodies.
 */
const MAX_LINES = 300;

export class DebugLog {
  private lines: string[] = [];

  constructor(private readonly isEnabled: () => boolean) {}

  log(message: string): void {
    if (!this.isEnabled()) return;
    const line = `${new Date().toISOString()} ${message}`;
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    console.debug(`[tiny-engineer] ${message}`);
  }

  entries(): string[] {
    return [...this.lines];
  }

  clear(): void {
    this.lines = [];
  }
}
