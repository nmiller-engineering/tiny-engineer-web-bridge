import type { Platform } from '../shared/types';
import type { PlatformProfile } from './base';
import { chatgptProfile } from './chatgpt';
import { claudeProfile } from './claude';
import { openwebuiProfile } from './openwebui';

export const PROFILES: Record<Platform, PlatformProfile> = {
  chatgpt: chatgptProfile,
  claude: claudeProfile,
  openwebui: openwebuiProfile,
};
