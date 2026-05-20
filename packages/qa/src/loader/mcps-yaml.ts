import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

export function loadMcpServerNames(agentDir: string): string[] {
  const filePath = join(agentDir, 'mcps.yaml');
  if (!existsSync(filePath)) return [];
  const parsed = load(readFileSync(filePath, 'utf-8'));
  if (!Array.isArray(parsed)) return [];
  const names: string[] = [];
  for (const entry of parsed) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { name?: unknown }).name === 'string'
    ) {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}
