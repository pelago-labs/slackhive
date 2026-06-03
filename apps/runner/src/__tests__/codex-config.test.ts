import { describe, it, expect } from 'vitest';
import type { McpServer, Permission } from '@slackhive/shared';
import { agentHasBash, buildThreadOptions, buildCodexConfig } from '../backends/codex-config';

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
});
