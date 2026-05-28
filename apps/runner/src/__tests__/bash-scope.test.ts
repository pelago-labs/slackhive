/**
 * @fileoverview Unit tests for the Bash permission baseline.
 *
 * Pins the security boundary applied to ANY agent that has Bash access
 * (whether plain "Bash" or with operator-defined Bash() patterns):
 *   - Host CLIs that auto-load identity (gh, aws, kubectl, …) are denied.
 *   - Host-secret paths (~/.config, ~/.aws, ~/.ssh, ~/.kube) are denied.
 *   - Direct DB access (sqlite3 against SlackHive's own data.db) is denied.
 *   - Process / sys introspection (/proc, /sys) is denied.
 *   - Global / user-site package installs (escape session scope) are denied.
 *   - Cross-clone into other agents' or host paths is denied.
 *   - Shell-escape commands (eval, bash -c, sh -c) that defeat glob matching
 *     are denied.
 *   - Common dev / test tooling (git, npm, pip, pytest, …) stays in the allow
 *     baseline so existing agents keep working without operator changes.
 *
 * If a future refactor removes one of these patterns, the corresponding test
 * fails before the leak ships.
 *
 * @module runner/__tests__/bash-scope.test
 */

import { describe, it, expect } from 'vitest';
import { buildBashDenyBaseline, buildBashAllowBaseline } from '../claude-handler.js';

describe('buildBashDenyBaseline', () => {
  const deny = buildBashDenyBaseline('/tmp/agents');

  it('blocks host CLIs that auto-load identity from local config', () => {
    // gh reads ~/.config/gh/hosts.yml, aws reads ~/.aws/credentials, kubectl
    // reads ~/.kube/config — all owned by the same OS user as the runner,
    // so these CLIs would otherwise act as the host user.
    expect(deny).toContain('Bash(gh *)');
    expect(deny).toContain('Bash(aws *)');
    expect(deny).toContain('Bash(kubectl *)');
    expect(deny).toContain('Bash(ssh *)');
    expect(deny).toContain('Bash(scp *)');
    expect(deny).toContain('Bash(gcloud *)');
    expect(deny).toContain('Bash(az *)');
    expect(deny).toContain('Bash(docker *)');
    expect(deny).toContain('Bash(terraform *)');
    expect(deny).toContain('Bash(helm *)');
  });

  it('blocks direct DB access (could read SlackHive own data.db)', () => {
    expect(deny).toContain('Bash(sqlite3 *)');
    expect(deny).toContain('Bash(psql *)');
    expect(deny).toContain('Bash(mysql *)');
    expect(deny).toContain('Bash(mongosh *)');
    expect(deny).toContain('Bash(redis-cli *)');
  });

  it('blocks reads of host secret paths', () => {
    // Tilde and absolute /home/admin both covered — agent could write either.
    expect(deny).toContain('Bash(* ~/.config/*)');
    expect(deny).toContain('Bash(* ~/.aws/*)');
    expect(deny).toContain('Bash(* ~/.ssh/*)');
    expect(deny).toContain('Bash(* ~/.kube/*)');
    expect(deny).toContain('Bash(* /home/admin/.ssh/*)');
    expect(deny).toContain('Bash(* /home/admin/.aws/*)');
    expect(deny).toContain('Bash(* /home/admin/.config/*)');
  });

  it('blocks env var introspection', () => {
    expect(deny).toContain('Bash(cat *.env*)');
    // `Bash(env*)` (not `Bash(env)`) so `env | grep AUTH_SECRET` is also blocked.
    // Bare `Bash(env)` would only match a zero-arg invocation.
    expect(deny).toContain('Bash(env*)');
    expect(deny).not.toContain('Bash(env)');
    expect(deny).toContain('Bash(printenv*)');
    // /proc/<pid>/environ leaks the running process env (incl. AUTH_SECRET)
    expect(deny).toContain('Bash(* /proc/*)');
    expect(deny).toContain('Bash(* /sys/*)');
  });

  it('blocks `go install` (writes to ~/go/bin outside the session scope)', () => {
    expect(deny).toContain('Bash(go install *)');
  });

  it('deny baseline is non-trivially sized (catches gut-the-list refactors)', () => {
    // Floor chosen well below the current count (~70+) so legitimate trims
    // don't fail this test, but a refactor that drops half the categories does.
    expect(deny.length).toBeGreaterThan(50);
  });

  it('blocks global / user-site package installs that escape session scope', () => {
    // npm -g writes to /usr/local/lib/node_modules; --user writes to ~/.local
    expect(deny).toContain('Bash(npm install -g *)');
    expect(deny).toContain('Bash(npm install*-g*)'); // catches `npm install foo -g` form
    expect(deny).toContain('Bash(npm i -g *)');
    expect(deny).toContain('Bash(yarn global *)');
    expect(deny).toContain('Bash(pnpm add -g *)');
    expect(deny).toContain('Bash(pip install --user *)');
    expect(deny).toContain('Bash(pip3 install --user *)');
    expect(deny).toContain('Bash(pip install*--user*)'); // catches `pip install foo --user`
    expect(deny).toContain('Bash(pip install -t /home/*)');
    expect(deny).toContain('Bash(pip install -t /usr/*)');
    expect(deny).toContain('Bash(uv tool install *)');
  });

  it('blocks cross-clone into host or other-agent paths', () => {
    expect(deny).toContain('Bash(git clone * /home/*)');
    expect(deny).toContain('Bash(git clone * /etc/*)');
    expect(deny).toContain('Bash(git clone * /usr/*)');
    expect(deny).toContain('Bash(git clone * /tmp/agents/*)');
  });

  it('blocks shell-escape commands that defeat glob pattern matching', () => {
    // Without these, an agent could route any blocked command via
    // `bash -c "<blocked>"` since the SDK matches on the literal command string.
    expect(deny).toContain('Bash(eval *)');
    expect(deny).toContain('Bash(bash -c *)');
    expect(deny).toContain('Bash(sh -c *)');
    expect(deny).toContain('Bash(zsh -c *)');
    expect(deny).toContain('Bash(* | bash)');
    expect(deny).toContain('Bash(* | sh)');
  });

  it('blocks cross-agent reads under the agents tree', () => {
    // Existing rules — kept so nancy can't read /tmp/agents/dinesh/* etc.
    expect(deny).toContain('Bash(cat /tmp/agents/*)');
    expect(deny).toContain('Bash(ls /tmp/agents/*)');
    expect(deny).toContain('Bash(find /tmp/agents/*)');
    expect(deny).toContain('Bash(grep * /tmp/agents/*)');
    expect(deny).toContain('Bash(git -C /tmp/agents/*)');
  });

  it('blocks already-banned destructive ops and network exfil', () => {
    expect(deny).toContain('Bash(rm *)');
    expect(deny).toContain('Bash(chmod *)');
    expect(deny).toContain('Bash(sudo *)');
    expect(deny).toContain('Bash(kill *)');
    expect(deny).toContain('Bash(curl *)');
    expect(deny).toContain('Bash(wget *)');
  });

  it('substitutes the agentsBaseDir for cross-agent rules (works for both /tmp/agents and ~/.slackhive/agents)', () => {
    const homeDeny = buildBashDenyBaseline('/home/admin/.slackhive/agents');
    expect(homeDeny).toContain('Bash(cat /home/admin/.slackhive/agents/*)');
    expect(homeDeny).toContain('Bash(git clone * /home/admin/.slackhive/agents/*)');
  });
});

describe('buildBashAllowBaseline', () => {
  const workDir = '/tmp/agents/nancy';
  const sessionWorkDir = '/tmp/agents/nancy/sessions/U1-C1-T1';
  const allow = buildBashAllowBaseline(workDir, sessionWorkDir);

  it('allows read-only file ops within the agent session scope', () => {
    expect(allow).toContain(`Bash(ls ${sessionWorkDir}/*)`);
    expect(allow).toContain(`Bash(cat ${sessionWorkDir}/*)`);
    expect(allow).toContain(`Bash(find ${sessionWorkDir}/*)`);
    expect(allow).toContain(`Bash(grep * ${sessionWorkDir}/*)`);
    // Also under the workDir (CLAUDE.md, knowledge/, .claude/commands/)
    expect(allow).toContain(`Bash(ls ${workDir}/*)`);
    expect(allow).toContain(`Bash(cat ${workDir}/*)`);
  });

  it('allows trivially safe utilities', () => {
    expect(allow).toContain('Bash(echo *)');
    expect(allow).toContain('Bash(pwd)');
    expect(allow).toContain('Bash(date)');
    expect(allow).toContain('Bash(jq *)');
    expect(allow).toContain('Bash(wc *)');
  });

  it('allows common dev tooling — git / npm / python / uv / pytest', () => {
    // These all default to writing in cwd; deny baseline blocks the
    // scope-escape variants (-g, --user, etc.).
    expect(allow).toContain('Bash(git clone *)');
    expect(allow).toContain('Bash(git status)');
    expect(allow).toContain('Bash(git log *)');
    expect(allow).toContain('Bash(npm install *)');
    expect(allow).toContain('Bash(npm test *)');
    expect(allow).toContain('Bash(npx *)');
    expect(allow).toContain('Bash(python3 *)');
    expect(allow).toContain('Bash(pip install *)');
    expect(allow).toContain('Bash(uv *)');
    expect(allow).toContain('Bash(pytest *)');
    expect(allow).toContain('Bash(python3 -m pytest *)');
    expect(allow).toContain('Bash(vitest *)');
    expect(allow).toContain('Bash(make *)');
  });

  it('allows go subcommands narrowly (test/build/run/mod/vet/fmt) but NOT `go install`', () => {
    // `Bash(go *)` would have allowed `go install <pkg>` which writes to
    // ~/go/bin (outside session scope). Enumerate the subcommands instead.
    expect(allow).toContain('Bash(go test *)');
    expect(allow).toContain('Bash(go build *)');
    expect(allow).toContain('Bash(go run *)');
    expect(allow).toContain('Bash(go mod *)');
    expect(allow).toContain('Bash(go vet *)');
    expect(allow).toContain('Bash(go fmt *)');
    expect(allow).not.toContain('Bash(go *)');
    expect(allow).not.toContain('Bash(go install *)');
  });

  it('does NOT include any host-CLI or host-secret pattern (those live only in deny)', () => {
    // Sanity: nothing in allow should accidentally re-enable a leaky CLI.
    expect(allow).not.toContain('Bash(gh *)');
    expect(allow).not.toContain('Bash(aws *)');
    expect(allow).not.toContain('Bash(kubectl *)');
    expect(allow).not.toContain('Bash(sqlite3 *)');
    expect(allow.some(p => p.includes('~/.aws'))).toBe(false);
    expect(allow.some(p => p.includes('~/.ssh'))).toBe(false);
  });
});
