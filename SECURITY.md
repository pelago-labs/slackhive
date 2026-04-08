# Security Policy

## Supported Versions

Only the latest release of SlackHive receives security fixes.

| Version | Supported |
|---------|-----------|
| 0.1.x (latest) | ✅ |
| < 0.1.x | ❌ |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use [GitHub's private security advisory feature](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) to report vulnerabilities confidentially:

1. Go to the [Security tab](https://github.com/pelago-labs/slackhive/security/advisories/new) of this repository
2. Click **"Report a vulnerability"**
3. Fill in the details

Alternatively, email **conduct@slackhive.dev** with the subject line `[SECURITY] <brief description>`.

## Response Timeline

| Stage | Target |
|-------|--------|
| Acknowledgement | Within 48 hours |
| Initial assessment | Within 5 business days |
| Patch for critical issues | Within 14 days |
| Patch for moderate issues | Within 30 days |

## Scope

Issues we consider in-scope:

- Authentication bypass or session hijacking
- SQL injection or data exposure
- SSRF via MCP server configuration
- Privilege escalation between user roles
- Secrets leaked in logs or API responses

Out of scope:

- Vulnerabilities in third-party dependencies (report to upstream)
- Rate limiting / DoS on self-hosted instances
- Issues requiring physical access to the host
