import { describe, it, expect } from 'vitest';
import type { McpServer, Permission } from '@slackhive/shared';
import { agentHasBash, buildThreadOptions, buildCodexConfig, buildIdentityInstructions, isSessionScopedServer, sessionScopedSecrets } from '../backends/codex-config';

const mcp = (name: string, type: string, config: Record<string, unknown>): McpServer =>
  ({ id: name, name, type, config } as unknown as McpServer);

describe('codex-config / agentHasBash', () => {
  it('is false with no permissions (default Read/Write/Edit/Glob/Grep, no shell)', () => {
    expect(agentHasBash(null)).toBe(false);
    expect(agentHasBash({ allowedTools: ['Read', 'Write', 'Edit'] } as Permission)).toBe(false);
  });
  it('is true for plain Bash or a Bash(pattern)', () => {
    expect(agentHasBash({ allowedTools: ['Read', 'Bash'] } as Permission)).toBe(true);
    expect(agentHasBash({ allowedTools: ['Bash(git *)'] } as Permission)).toBe(true);
  });
});

describe('codex-config / persona via developer_instructions', () => {
  it('builds an in-character identity block from name + persona + description', () => {
    const out = buildIdentityInstructions({ name: 'Gilfoyle', persona: 'Cold, deadpan engineer.', description: 'Data analyst.' });
    expect(out).toContain('You are Gilfoyle');
    expect(out).toContain('in character');
    expect(out).toContain('Cold, deadpan engineer.');
    expect(out).toContain('Data analyst.');
  });

  it('returns empty when there is no persona or description (nothing to assert)', () => {
    expect(buildIdentityInstructions({ name: 'Bot', persona: null, description: null })).toBe('');
    expect(buildIdentityInstructions({ name: 'Bot', persona: '  ', description: '' })).toBe('');
  });

  it('does not set persona in the Codex config (it rides in the prompt, not --config)', () => {
    // `developer_instructions` is not a real Codex CLI config key — it was
    // silently dropped. Persona is now prepended to the turn prompt instead.
    const cfg = buildCodexConfig([], {}, () => undefined);
    expect(cfg.developer_instructions).toBeUndefined();
  });
});

describe('codex-config / buildThreadOptions', () => {
  it('maps acceptEdits + web search onto thread options (danger-full-access for headless MCP — codex#16685)', () => {
    const opts = buildThreadOptions({ sessionWorkDir: '/w/s', workDir: '/w', model: 'gpt-5.4', networkAccess: false });
    expect(opts).toMatchObject({
      workingDirectory: '/w/s',
      skipGitRepoCheck: true,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      webSearchEnabled: true,
      webSearchMode: 'live',
      model: 'gpt-5.4',
    });
  });
  it('enables network when the agent has Bash', () => {
    expect(buildThreadOptions({ sessionWorkDir: '/w/s', workDir: '/w', model: 'm', networkAccess: true }).networkAccessEnabled).toBe(true);
  });
});

describe('codex-config / buildCodexConfig', () => {
  const noProxy = () => undefined;
  const withProxy = (url: string) => () => url;

  it('forces file-based auth, disables Codex memory, and sets a generous doc cap', () => {
    const cfg = buildCodexConfig([], {}, noProxy) as Record<string, unknown>;
    expect(cfg.cli_auth_credentials_store).toBe('file');
    expect(cfg.memories).toEqual({ use_memories: false });
    expect(typeof cfg.project_doc_max_bytes).toBe('number');
    expect(cfg.mcp_servers).toBeUndefined(); // omitted when there are no servers
  });

  it('routes a stdio MCP server through the local proxy URL (elicitation shield)', () => {
    const cfg = buildCodexConfig(
      [mcp('gh', 'stdio', { command: 'gh-mcp', args: ['--stdio'] })],
      {}, withProxy('http://127.0.0.1:14300/mcp'),
    ) as { mcp_servers: Record<string, unknown> };
    expect(cfg.mcp_servers.gh).toEqual({ url: 'http://127.0.0.1:14300/mcp' });
  });

  it('falls back to direct stdio spawn when no proxy is available', () => {
    const cfg = buildCodexConfig(
      [mcp('gh', 'stdio', { command: 'gh-mcp', args: ['--stdio'], env: { TOKEN: 't' } })],
      {}, noProxy,
    ) as { mcp_servers: Record<string, unknown> };
    expect(cfg.mcp_servers.gh).toEqual({ command: 'gh-mcp', args: ['--stdio'], env: { TOKEN: 't' } });
  });

  it('translates an http MCP server to url + resolved headers (passthrough, no proxy)', () => {
    const cfg = buildCodexConfig(
      [mcp('remote', 'http', { url: 'https://mcp.example.com', headers: { Authorization: 'Bearer ' }, envRefs: { Authorization: 'TOK' } })],
      { TOK: 'xyz' }, noProxy,
    ) as { mcp_servers: Record<string, unknown> };
    expect(cfg.mcp_servers.remote).toEqual({ url: 'https://mcp.example.com', http_headers: { Authorization: 'Bearer xyz' } });
  });

  it('OMITS session-scoped servers from the shared config (they are registered per-session)', () => {
    const cfg = buildCodexConfig(
      [
        mcp('git', 'stdio', { tsSource: 'const dir = process.env.SESSION_WORK_DIR; // clones here' }),
        mcp('notion', 'stdio', { tsSource: 'const t = process.env.NOTION_TOKEN; // stateless' }),
      ],
      {}, withProxy('http://127.0.0.1:14300/mcp'),
    ) as { mcp_servers: Record<string, unknown> };
    // git is session-scoped → excluded; notion is shared → present.
    expect(cfg.mcp_servers.git).toBeUndefined();
    expect(cfg.mcp_servers.notion).toEqual({ url: 'http://127.0.0.1:14300/mcp' });
  });

  it('omits mcp_servers entirely when every server is session-scoped', () => {
    const cfg = buildCodexConfig(
      [mcp('git', 'stdio', { tsSource: 'process.env.SESSION_WORK_DIR' })],
      {}, withProxy('http://127.0.0.1:14300/mcp'),
    ) as Record<string, unknown>;
    expect(cfg.mcp_servers).toBeUndefined();
  });
});

describe('codex-config / isSessionScopedServer', () => {
  it('is true for an inline-TS server whose source reads SESSION_WORK_DIR', () => {
    expect(isSessionScopedServer(mcp('git', 'stdio', { tsSource: 'const d = process.env.SESSION_WORK_DIR;' }))).toBe(true);
  });
  it('is false for an inline-TS server that does not read SESSION_WORK_DIR', () => {
    expect(isSessionScopedServer(mcp('notion', 'stdio', { tsSource: 'const t = process.env.NOTION_TOKEN;' }))).toBe(false);
  });
  it('is false when there is no tsSource (binary/remote servers)', () => {
    expect(isSessionScopedServer(mcp('datadog', 'stdio', { command: 'datadog-mcp' }))).toBe(false);
    expect(isSessionScopedServer(mcp('remote', 'http', { url: 'https://mcp.example.com' }))).toBe(false);
  });
});

describe('codex-config / sessionScopedSecrets', () => {
  const gitLike = (envRefs: Record<string, string>) =>
    mcp('git', 'stdio', { tsSource: 'process.env.SESSION_WORK_DIR', envRefs });

  it('forwards only session-scoped secrets, keyed by the subKey the server reads (not the store key)', () => {
    const out = sessionScopedSecrets(
      [
        gitLike({ GIT_TOKEN: 'my-github-secret' }),              // session-scoped, remapped name
        mcp('notion', 'stdio', { tsSource: 'process.env.NOTION_TOKEN', envRefs: { NOTION_TOKEN: 'notion-store' } }), // not session-scoped
      ],
      { 'my-github-secret': 'ghp_xxx', 'notion-store': 'secret_yyy' },
    );
    // Keyed by the subKey (GIT_TOKEN), value from the store key — so the per-session
    // env_vars=["GIT_TOKEN"] forward resolves. Notion (not session-scoped) is excluded.
    expect(out).toEqual({ GIT_TOKEN: 'ghp_xxx' });
  });

  it('does not leak the agent store and skips refs with no resolved value', () => {
    const out = sessionScopedSecrets(
      [gitLike({ GITHUB_PERSONAL_ACCESS_TOKEN: 'GITHUB_PERSONAL_ACCESS_TOKEN', MISSING: 'absent-key' })],
      { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxx', UNRELATED_SECRET: 'do-not-leak' },
    );
    expect(out).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxx' });
    expect(out.UNRELATED_SECRET).toBeUndefined();
  });
});
