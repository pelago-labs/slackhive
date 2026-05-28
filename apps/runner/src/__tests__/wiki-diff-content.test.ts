/**
 * @fileoverview Unit tests for the wiki incremental-sync diff path.
 *
 * Covers:
 *   - buildDiffFocusedRepoContent: section composition for added / modified /
 *     deleted / renamed files, README context block, empty-diff edge case.
 *   - processRemovedArticles: happy path, path-traversal protection, manifest
 *     cleanup, defensive handling of non-string entries.
 *
 * The diff path is the highest-risk untested code in PR #104 — a regression
 * here can silently delete the wrong wiki article, surfacing only when a
 * human notices content missing.
 *
 * @module runner/__tests__/wiki-diff-content
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDiffFocusedRepoContent,
  processRemovedArticles,
  type RepoDiff,
  type SourceManifest,
} from '../agent-runner';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SOURCE = { id: 's-id', name: 'my-repo', repo_url: 'https://github.com/x/y' };

/** Stub `read` returning a deterministic body for any path containing the marker. */
function makeReader(files: Record<string, string>): (p: string, max?: number) => string {
  return (p: string) => {
    for (const [needle, body] of Object.entries(files)) {
      if (p.endsWith(needle)) return body;
    }
    return '';
  };
}

const fileBlock = (relPath: string, content: string) => `\n### ${relPath}\n\`\`\`\n${content}\n\`\`\`\n`;
const budgetSection = (title: string, content: string) => `\n## ${title}\n${content}`;

const emptyDiff: RepoDiff = { added: [], modified: [], deleted: [], renamed: [] };

// ─── buildDiffFocusedRepoContent ─────────────────────────────────────────────

describe('buildDiffFocusedRepoContent', () => {
  it('emits the header line with SHA range and per-bucket counts', () => {
    const out = buildDiffFocusedRepoContent('/tmp/r', emptyDiff, SOURCE, 'aaaaaaa1234', 'bbbbbbb5678', 'main',
      makeReader({}), fileBlock, budgetSection);
    expect(out).toContain('# Repository: my-repo (incremental diff)');
    expect(out).toContain('Branch: main');
    expect(out).toContain('Range: aaaaaaa..bbbbbbb');
    expect(out).toContain('added: 0, modified: 0, deleted: 0, renamed: 0');
  });

  it('includes a README context block when present', () => {
    const out = buildDiffFocusedRepoContent('/tmp/r', emptyDiff, SOURCE, 'a', 'b', 'main',
      makeReader({ 'README.md': '# my-repo\nThis is a test.' }), fileBlock, budgetSection);
    expect(out).toContain('## README (for context)');
    expect(out).toContain('This is a test.');
  });

  it('emits added file content under the Added section', () => {
    const diff: RepoDiff = { ...emptyDiff, added: ['src/feature.ts'] };
    const out = buildDiffFocusedRepoContent('/tmp/r', diff, SOURCE, 'a', 'b', 'main',
      makeReader({ 'src/feature.ts': 'export const x = 1;' }), fileBlock, budgetSection);
    expect(out).toContain('## Added files (NEW)');
    expect(out).toContain('### src/feature.ts');
    expect(out).toContain('export const x = 1;');
  });

  it('emits modified file content under the Modified section', () => {
    const diff: RepoDiff = { ...emptyDiff, modified: ['src/auth.ts'] };
    const out = buildDiffFocusedRepoContent('/tmp/r', diff, SOURCE, 'a', 'b', 'main',
      makeReader({ 'src/auth.ts': 'function authenticate() {}' }), fileBlock, budgetSection);
    expect(out).toContain('## Modified files (UPDATED)');
    expect(out).toContain('### src/auth.ts');
    expect(out).toContain('function authenticate()');
  });

  it('lists deleted file paths but does NOT ship their content', () => {
    const diff: RepoDiff = { ...emptyDiff, deleted: ['src/legacy.ts'] };
    // Reader returns content for the deleted path — handler should ignore it.
    const out = buildDiffFocusedRepoContent('/tmp/r', diff, SOURCE, 'a', 'b', 'main',
      makeReader({ 'src/legacy.ts': 'this should not be shipped' }), fileBlock, budgetSection);
    expect(out).toContain('## Deleted files (mark articles that referenced these for removal)');
    expect(out).toContain('- src/legacy.ts');
    expect(out).not.toContain('this should not be shipped');
  });

  it('emits both the rename mapping AND the new file content for renames', () => {
    const diff: RepoDiff = { ...emptyDiff, renamed: [{ from: 'old/path.ts', to: 'new/path.ts' }] };
    const out = buildDiffFocusedRepoContent('/tmp/r', diff, SOURCE, 'a', 'b', 'main',
      makeReader({ 'new/path.ts': 'renamed content' }), fileBlock, budgetSection);
    expect(out).toContain('Renamed files (update article references from old → new path)');
    expect(out).toContain('- old/path.ts → new/path.ts');
    expect(out).toContain('## Renamed files (new content)');
    // Per-file label is `${to} (renamed from ${from})` in the new-content section.
    expect(out).toContain('new/path.ts (renamed from old/path.ts)');
    expect(out).toContain('renamed content');
  });

  it('returns just the header for an empty diff with no README', () => {
    const out = buildDiffFocusedRepoContent('/tmp/r', emptyDiff, SOURCE, 'a', 'b', 'main',
      makeReader({}), fileBlock, budgetSection);
    expect(out).toContain('# Repository: my-repo (incremental diff)');
    expect(out).not.toContain('## Added');
    expect(out).not.toContain('## Modified');
    expect(out).not.toContain('## Deleted');
    expect(out).not.toContain('## Renamed');
    expect(out).not.toContain('## README');
  });
});

// ─── processRemovedArticles ──────────────────────────────────────────────────

describe('processRemovedArticles', () => {
  let wikiDir: string;
  let logInfo: ReturnType<typeof vi.fn>;
  let logWarn: ReturnType<typeof vi.fn>;
  let log: { info: typeof logInfo; warn: typeof logWarn };

  beforeEach(() => {
    wikiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-diff-test-'));
    logInfo = vi.fn();
    logWarn = vi.fn();
    log = { info: logInfo, warn: logWarn };
  });

  afterEach(() => {
    try { fs.rmSync(wikiDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('removes an article and trims it from the manifest', () => {
    const articlePath = 'my-repo/concepts/auth.md';
    const fullPath = path.join(wikiDir, articlePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, '# Auth\n\nold content', 'utf-8');

    const manifest: SourceManifest = {
      'my-repo': { created: [articlePath], updated: ['my-repo/other.md'] },
    };

    processRemovedArticles(wikiDir, 'my-repo', 'my-repo', [articlePath], manifest, log);

    expect(fs.existsSync(fullPath)).toBe(false);
    expect(manifest['my-repo'].created).toEqual([]);
    expect(manifest['my-repo'].updated).toEqual(['my-repo/other.md']);
    expect(logInfo).toHaveBeenCalledWith('[wiki] Removed article (source file deleted)', { path: articlePath });
  });

  it('rejects path-traversal attempts and leaves the targeted file alone', () => {
    // Set up a "victim" file outside the source slug — the targeted path
    // would resolve to it without traversal protection.
    const victim = path.join(wikiDir, 'other-source/secret.md');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, 'should-stay', 'utf-8');

    const manifest: SourceManifest = { 'my-repo': { created: [], updated: [] } };
    // Path that, after the sourceSlug-prefix check, tries to escape.
    processRemovedArticles(wikiDir, 'my-repo', 'my-repo', ['../other-source/secret.md'], manifest, log);

    expect(fs.existsSync(victim)).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(
      '[wiki] Skipping remove path outside source slug',
      expect.objectContaining({ path: expect.stringContaining('other-source/secret.md') }),
    );
  });

  it('skips non-string entries without throwing', () => {
    const manifest: SourceManifest = { 'my-repo': { created: [], updated: [] } };
    expect(() =>
      processRemovedArticles(wikiDir, 'my-repo', 'my-repo', [null, 42, undefined, { x: 1 }] as unknown[], manifest, log),
    ).not.toThrow();
    // No info or warn should fire — non-string entries are silently skipped
    // (they're indistinguishable from a malformed Claude return; a noisy
    // warn would spam logs on every diff response).
    expect(logInfo).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('is a no-op when the path does not exist on disk', () => {
    const manifest: SourceManifest = { 'my-repo': { created: ['my-repo/missing.md'], updated: [] } };
    processRemovedArticles(wikiDir, 'my-repo', 'my-repo', ['my-repo/missing.md'], manifest, log);
    // Nothing was unlinked, so manifest stays as-is and no info log fires.
    expect(manifest['my-repo'].created).toEqual(['my-repo/missing.md']);
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('auto-prefixes the sourceSlug when Claude omits it', () => {
    const articlePath = 'my-repo/concepts/x.md';
    const fullPath = path.join(wikiDir, articlePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, 'x', 'utf-8');

    const manifest: SourceManifest = { 'my-repo': { created: [articlePath], updated: [] } };
    // Pass the path WITHOUT the slug prefix — handler should add it.
    processRemovedArticles(wikiDir, 'my-repo', 'my-repo', ['concepts/x.md'], manifest, log);

    expect(fs.existsSync(fullPath)).toBe(false);
  });
});
