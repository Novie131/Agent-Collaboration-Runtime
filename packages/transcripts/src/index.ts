import { canonicalAdapter } from './canonical.js';
import { claudeCodeAdapter } from './claude-code.js';
import type { Adapter, AdapterInfo } from './types.js';

export const ADAPTERS: Record<string, Adapter> = {
  canonical: canonicalAdapter,
  'claude-code': claudeCodeAdapter,
};

export function listAdapterInfo(): AdapterInfo[] {
  return Object.values(ADAPTERS).map((a) => a.info);
}
