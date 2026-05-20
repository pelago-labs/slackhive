import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export function loadWikiEntities(agentDir: string): string[] {
  const wikiDir = join(agentDir, 'wiki');
  if (!existsSync(wikiDir)) return [];
  const acc: string[] = [];
  walk(wikiDir, wikiDir, acc);
  return acc;
}

function walk(dir: string, root: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, root, acc);
    } else if (entry.endsWith('.md')) {
      acc.push(relative(root, full));
    }
  }
}
