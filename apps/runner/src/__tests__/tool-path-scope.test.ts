/**
 * @fileoverview Unit tests for the Read/Write/Edit path-scope hook.
 *
 * Pins the security boundary applied to file-tool calls (the SDK Read tool,
 * by default, can read any path the host OS user can read — including
 * ~/.config/gh/hosts.yml, ~/.aws/credentials, /proc/<pid>/environ, the
 * slackhive .env, and the slackhive data.db).
 *
 * Tested cases:
 *   - Paths inside the agent's workDir → allowed (covers wiki, knowledge, CLAUDE.md, .claude/commands)
 *   - Paths inside the agent's sessionWorkDir → allowed (per-session scratch)
 *   - Paths outside both (host secrets, other agents' dirs, /proc, /etc) → denied
 *   - Relative paths → resolved against sessionWorkDir before checking
 *   - The hook fires for Read / Write / Edit / NotebookEdit but no-ops for Bash et al.
 *   - The hook respects the PreToolUse event shape and emits a clear deny reason
 *
 * @module runner/__tests__/tool-path-scope.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  checkPathInAgentScope,
  buildPreToolUsePathScopeHook,
} from '../claude-handler.js';

describe('checkPathInAgentScope', () => {
  const workDir = '/tmp/agents/nancy';
  const sessionWorkDir = '/tmp/agents/nancy/sessions/U1-C1-T1';

  it('allows reads inside the agent workDir (CLAUDE.md, wiki, knowledge, commands)', () => {
    expect(checkPathInAgentScope(`${workDir}/CLAUDE.md`, workDir, sessionWorkDir)).toBeNull();
    expect(checkPathInAgentScope(`${workDir}/knowledge/wiki/README.md`, workDir, sessionWorkDir)).toBeNull();
    expect(checkPathInAgentScope(`${workDir}/knowledge/sources/runbook.pdf`, workDir, sessionWorkDir)).toBeNull();
    expect(checkPathInAgentScope(`${workDir}/.claude/commands/wiki.md`, workDir, sessionWorkDir)).toBeNull();
  });

  it('allows reads inside the session workDir (per-thread scratch + memory)', () => {
    expect(checkPathInAgentScope(`${sessionWorkDir}/foo.py`, workDir, sessionWorkDir)).toBeNull();
    expect(checkPathInAgentScope(`${sessionWorkDir}/.claude/memory/feedback.md`, workDir, sessionWorkDir)).toBeNull();
    expect(checkPathInAgentScope(`${sessionWorkDir}/repos/some-clone/src/main.go`, workDir, sessionWorkDir)).toBeNull();
  });

  it('denies host-secret reads (the actual leak we are closing)', () => {
    expect(checkPathInAgentScope('/home/admin/.config/gh/hosts.yml', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
    expect(checkPathInAgentScope('/home/admin/.aws/credentials', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
    expect(checkPathInAgentScope('/home/admin/.ssh/id_ed25519', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
    expect(checkPathInAgentScope('/home/admin/.kube/config', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
  });

  it('denies process-env introspection (AUTH_SECRET via /proc/<pid>/environ)', () => {
    expect(checkPathInAgentScope('/proc/123/environ', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
    expect(checkPathInAgentScope('/proc/self/environ', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
    expect(checkPathInAgentScope('/sys/class/net/eth0/address', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
  });

  it('denies reads of SlackHive own state (.env, data.db, oauth credentials)', () => {
    expect(checkPathInAgentScope('/home/admin/aman/slackhive/.env', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
    expect(checkPathInAgentScope('/home/admin/.slackhive/data.db', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
    expect(checkPathInAgentScope('/home/admin/.claude/.credentials.json', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
  });

  it("denies cross-agent reads (Nancy reading Dinesh's workdir)", () => {
    expect(checkPathInAgentScope('/tmp/agents/dinesh/CLAUDE.md', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
    expect(checkPathInAgentScope('/tmp/agents/dinesh/sessions/abc/file.py', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
    expect(checkPathInAgentScope('/tmp/agents/dinesh/knowledge/wiki/secret.md', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
  });

  it('resolves relative paths against sessionWorkDir before checking', () => {
    // `./foo.py` from cwd is inside scope.
    expect(checkPathInAgentScope('./foo.py', workDir, sessionWorkDir)).toBeNull();
    expect(checkPathInAgentScope('foo.py', workDir, sessionWorkDir)).toBeNull();
    // `../foo.py` from sessionWorkDir is `/tmp/agents/nancy/sessions/foo.py` — still inside workDir.
    expect(checkPathInAgentScope('../foo.py', workDir, sessionWorkDir)).toBeNull();
    // `../../../etc/passwd` resolves to /etc/passwd — outside scope.
    expect(checkPathInAgentScope('../../../etc/passwd', workDir, sessionWorkDir)).toMatch(/outside agent scope/);
  });

  it('denies an empty / missing file path (conservative — model must retry)', () => {
    expect(checkPathInAgentScope(undefined, workDir, sessionWorkDir)).toMatch(/no file path/);
    expect(checkPathInAgentScope('', workDir, sessionWorkDir)).toMatch(/no file path/);
  });

  it('works for the slackhive-agents production layout (~/.slackhive/agents)', () => {
    const homeWorkDir = '/home/admin/.slackhive/agents/nancy';
    const homeSession = '/home/admin/.slackhive/agents/nancy/sessions/U1-C1-T1';
    expect(checkPathInAgentScope(`${homeWorkDir}/CLAUDE.md`, homeWorkDir, homeSession)).toBeNull();
    expect(checkPathInAgentScope(`${homeSession}/foo.py`, homeWorkDir, homeSession)).toBeNull();
    // Cross-agent still denied
    expect(checkPathInAgentScope('/home/admin/.slackhive/agents/dinesh/CLAUDE.md', homeWorkDir, homeSession)).toMatch(/outside agent scope/);
  });
});

describe('buildPreToolUsePathScopeHook', () => {
  const workDir = '/tmp/agents/nancy';
  const sessionWorkDir = '/tmp/agents/nancy/sessions/U1-C1-T1';

  function makeHookInput(tool: string, toolInput: Record<string, unknown>) {
    return {
      session_id: 'sess-1',
      transcript_path: '/tmp/transcript',
      cwd: sessionWorkDir,
      hook_event_name: 'PreToolUse' as const,
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id: 'tu-1',
    };
  }

  it('blocks Read of a host-secret path with a clear deny reason', async () => {
    const hook = buildPreToolUsePathScopeHook(workDir, sessionWorkDir);
    const out = await hook(
      makeHookInput('Read', { file_path: '/home/admin/.config/gh/hosts.yml' }) as any,
      'tu-1',
      { signal: new AbortController().signal },
    );
    expect(out).toMatchObject({
      decision: 'block',
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect((out as any).reason).toMatch(/outside agent scope/);
  });

  it('blocks Write outside the agent scope (e.g. trying to overwrite ~/.bashrc)', async () => {
    const hook = buildPreToolUsePathScopeHook(workDir, sessionWorkDir);
    const out = await hook(
      makeHookInput('Write', { file_path: '/home/admin/.bashrc', content: 'pwn' }) as any,
      'tu-2',
      { signal: new AbortController().signal },
    );
    expect((out as any).decision).toBe('block');
  });

  it('blocks Edit outside the agent scope (same path-class as Write)', async () => {
    const hook = buildPreToolUsePathScopeHook(workDir, sessionWorkDir);
    const out = await hook(
      makeHookInput('Edit', { file_path: '/etc/hosts', old_string: 'x', new_string: 'y' }) as any,
      'tu-3',
      { signal: new AbortController().signal },
    );
    expect((out as any).decision).toBe('block');
  });

  it('blocks NotebookEdit on notebooks outside the agent scope', async () => {
    const hook = buildPreToolUsePathScopeHook(workDir, sessionWorkDir);
    const out = await hook(
      makeHookInput('NotebookEdit', { notebook_path: '/home/admin/work/secret.ipynb', new_source: 'x' }) as any,
      'tu-4',
      { signal: new AbortController().signal },
    );
    expect((out as any).decision).toBe('block');
  });

  it('allows Read of CLAUDE.md and wiki files (workDir-scoped)', async () => {
    const hook = buildPreToolUsePathScopeHook(workDir, sessionWorkDir);
    const claudeMd = await hook(
      makeHookInput('Read', { file_path: `${workDir}/CLAUDE.md` }) as any,
      'tu-5',
      { signal: new AbortController().signal },
    );
    expect(claudeMd).toEqual({});
    const wiki = await hook(
      makeHookInput('Read', { file_path: `${workDir}/knowledge/wiki/onboarding.md` }) as any,
      'tu-6',
      { signal: new AbortController().signal },
    );
    expect(wiki).toEqual({});
  });

  it('allows Write inside the session workDir (per-session scratch)', async () => {
    const hook = buildPreToolUsePathScopeHook(workDir, sessionWorkDir);
    const out = await hook(
      makeHookInput('Write', { file_path: `${sessionWorkDir}/scratch.py`, content: 'x' }) as any,
      'tu-7',
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({});
  });

  it('no-ops on non-file tools (Bash, Glob, Grep, MCP tools)', async () => {
    const hook = buildPreToolUsePathScopeHook(workDir, sessionWorkDir);
    // Bash already has its own deny baseline; this hook shouldn't interfere.
    const bash = await hook(
      makeHookInput('Bash', { command: 'cat /home/admin/.aws/credentials' }) as any,
      'tu-8',
      { signal: new AbortController().signal },
    );
    expect(bash).toEqual({});
    // Glob doesn't take a file_path the way Read does.
    const glob = await hook(
      makeHookInput('Glob', { pattern: '**/*.py' }) as any,
      'tu-9',
      { signal: new AbortController().signal },
    );
    expect(glob).toEqual({});
    // MCP tool calls (prefixed with `mcp__`) bypass the hook — MCPs handle their own scoping.
    const mcp = await hook(
      makeHookInput('mcp__github__search', { q: 'pelago' }) as any,
      'tu-10',
      { signal: new AbortController().signal },
    );
    expect(mcp).toEqual({});
  });

  it('logs the deny event via the provided logger so audits can show what tried what', async () => {
    const logger = { warn: vi.fn() };
    const hook = buildPreToolUsePathScopeHook(workDir, sessionWorkDir, logger);
    await hook(
      makeHookInput('Read', { file_path: '/proc/self/environ' }) as any,
      'tu-11',
      { signal: new AbortController().signal },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Tool path-scope deny',
      expect.objectContaining({
        tool: 'Read',
        filePath: '/proc/self/environ',
        reason: expect.stringMatching(/outside agent scope/),
      }),
    );
  });
});
