# Changelog

All notable changes to SlackHive will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.1.18] - 2026-03-31

### Added

- **Per-agent write access control** — each agent can now be independently granted or restricted from write access, giving team admins fine-grained control over what individual agents can modify in a workspace.
- **CLAUDE.md editor** — a dedicated in-dashboard editor for the agent's `CLAUDE.md` context file, separate from the skills editor, allowing independent management of agent identity and instructions.
- **Slash command skills** — agents now support slash command-style skill definitions, enabling structured, triggerable capabilities alongside free-form instructions.
- **Version control and snapshots with diff view** — agent configurations (instructions, skills, CLAUDE.md) are now versioned. Users can create named snapshots, browse history, and view a syntax-highlighted diff between any two versions.
- **User role management** — workspace admins can assign and modify roles (admin, member, viewer) for all users directly from the dashboard, without requiring database access.
- **Collapsible sidebar** — the main navigation sidebar can now be collapsed to icon-only mode, freeing horizontal space on smaller screens and dense workflows.
- **Scheduled jobs** — agents support cron-style scheduled tasks, allowing recurring automation (e.g., daily summaries, periodic checks) to be configured per agent from the UI.
- **Memory viewer** — a dedicated UI panel to inspect an agent's active memory entries, making it easier to understand and debug long-running agent context.
- **Responsive design** — the web dashboard is now fully responsive and usable on tablet and mobile viewports, with adapted layouts for the sidebar, agent cards, and configuration panels.

---

[Unreleased]: https://github.com/amansrivastava17/slackhive/compare/v0.1.18...HEAD
[0.1.18]: https://github.com/amansrivastava17/slackhive/releases/tag/v0.1.18
