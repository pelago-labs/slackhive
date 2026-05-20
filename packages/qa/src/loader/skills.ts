import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Skill } from '../types';

export function loadSkills(agentDir: string): Skill[] {
  const skillsDir = join(agentDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  const files: string[] = [];
  walkMarkdown(skillsDir, files);
  return files.map((file) => parseSkill(file, skillsDir));
}

function walkMarkdown(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkMarkdown(full, acc);
    } else if (entry.endsWith('.md')) {
      acc.push(full);
    }
  }
}

function parseSkill(filePath: string, skillsRoot: string): Skill {
  const raw = readFileSync(filePath, 'utf-8');
  const path = relative(skillsRoot, filePath);

  // Slackhive convention: <!-- skill: <name> | owner: <owner> -->
  const commentMatch = raw.match(/<!--\s*skill:\s*([^\s|]+)/);

  // YAML frontmatter (alternative convention some agents use)
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  let fmName: string | undefined;
  let fmDescription: string | undefined;
  if (fmMatch) {
    fmName = fmMatch[1].match(/^name:\s*(.+?)$/m)?.[1].trim();
    fmDescription = fmMatch[1].match(/^description:\s*(.+?)$/m)?.[1].trim();
  }

  const fileBase = path.replace(/\.md$/, '');
  const name = fmName ?? commentMatch?.[1] ?? fileBase;
  const description = fmDescription ?? firstNonHeadingParagraph(raw);

  return { path, name, description, raw };
}

function firstNonHeadingParagraph(raw: string): string {
  const stripped = raw
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const line of stripped.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    return trimmed.slice(0, 200);
  }
  return '';
}
