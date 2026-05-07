/**
 * @fileoverview Unit tests for parseDiffNameStatus — the parser that turns
 * `git diff --name-status -M base..HEAD` output into a structured RepoDiff
 * for incremental wiki sync. Pure function, no I/O.
 *
 * @module runner/__tests__/parse-diff-name-status
 */

import { describe, it, expect } from 'vitest';
import { parseDiffNameStatus, type RepoDiff } from '../agent-runner';

describe('parseDiffNameStatus', () => {
  it('returns empty diff for empty input', () => {
    const result = parseDiffNameStatus('');
    expect(result).toEqual<RepoDiff>({ added: [], modified: [], deleted: [], renamed: [] });
  });

  it('returns empty diff for whitespace-only input', () => {
    expect(parseDiffNameStatus('   \n\n  \n')).toEqual<RepoDiff>({
      added: [], modified: [], deleted: [], renamed: [],
    });
  });

  it('parses A / M / D status codes', () => {
    const out = [
      'A\tsrc/new-file.ts',
      'M\tREADME.md',
      'D\tsrc/old-file.ts',
    ].join('\n');
    expect(parseDiffNameStatus(out)).toEqual<RepoDiff>({
      added: ['src/new-file.ts'],
      modified: ['README.md'],
      deleted: ['src/old-file.ts'],
      renamed: [],
    });
  });

  it('parses rename codes (R<score>) into the renamed bucket', () => {
    // Real git output: "R100\told.ts\tnew.ts" (100 = unchanged, score 0–100)
    const out = [
      'R100\tlib/old-name.ts\tlib/new-name.ts',
      'R85\tdocs/old.md\tdocs/new.md',
    ].join('\n');
    expect(parseDiffNameStatus(out)).toEqual<RepoDiff>({
      added: [],
      modified: [],
      deleted: [],
      renamed: [
        { from: 'lib/old-name.ts', to: 'lib/new-name.ts' },
        { from: 'docs/old.md', to: 'docs/new.md' },
      ],
    });
  });

  it('treats type changes (T) as modifications', () => {
    // T = file mode/type change (e.g., regular file ↔ symlink). For wiki
    // purposes it's effectively "the file changed", so bucket as modified.
    expect(parseDiffNameStatus('T\tscripts/hook.sh')).toEqual<RepoDiff>({
      added: [], modified: ['scripts/hook.sh'], deleted: [], renamed: [],
    });
  });

  it('treats copies (C<score>) as adds (the new path is what we care about)', () => {
    // C100 = exact copy. We don't track the source — Claude only needs to
    // know there's a new file at the destination path.
    expect(parseDiffNameStatus('C75\tsrc/origin.ts\tsrc/copy.ts')).toEqual<RepoDiff>({
      added: ['src/copy.ts'], modified: [], deleted: [], renamed: [],
    });
  });

  it('handles a realistic mixed diff', () => {
    const out = [
      'M\tpackage.json',
      'A\tsrc/feature/new-module.ts',
      'A\tsrc/feature/types.ts',
      'D\tsrc/legacy/deprecated.ts',
      'M\tREADME.md',
      'R98\tdocs/old-name.md\tdocs/renamed.md',
    ].join('\n');
    const result = parseDiffNameStatus(out);
    expect(result.added).toEqual(['src/feature/new-module.ts', 'src/feature/types.ts']);
    expect(result.modified).toEqual(['package.json', 'README.md']);
    expect(result.deleted).toEqual(['src/legacy/deprecated.ts']);
    expect(result.renamed).toEqual([{ from: 'docs/old-name.md', to: 'docs/renamed.md' }]);
  });

  it('skips malformed rename lines (missing target)', () => {
    // Defensive: a rename row with no second path is degenerate output —
    // drop silently rather than crash on parts[2] === undefined.
    expect(parseDiffNameStatus('R100\tonly-source.ts')).toEqual<RepoDiff>({
      added: [], modified: [], deleted: [], renamed: [],
    });
  });
});
