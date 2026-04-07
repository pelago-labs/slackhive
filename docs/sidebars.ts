import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Getting Started",
      collapsed: false,
      items: ["intro", "quick-start"],
    },
    {
      type: "category",
      label: "Guides",
      collapsed: false,
      items: [
        "guides/create-agent",
        "guides/boss-team",
        "guides/slack-install",
        "guides/mcp-setup",
        "guides/env-vars",
        "guides/scheduled-jobs",
        "guides/channel-restrictions",
        "guides/export-import",
      ],
    },
    {
      type: "category",
      label: "Concepts",
      collapsed: false,
      items: [
        "concepts/agents",
        "concepts/boss-agent",
        "concepts/memory",
        "concepts/skills",
        "concepts/mcp-servers",
        "concepts/version-control",
      ],
    },
    {
      type: "category",
      label: "Configuration",
      collapsed: false,
      items: [
        "configuration/claude-auth",
        "configuration/auth-roles",
        "configuration/settings",
        "configuration/env-vars",
        "configuration/self-hosting",
      ],
    },
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: [
        "reference/cli",
        "reference/agent-fields",
        "reference/slack-permissions",
      ],
    },
  ],
};

export default sidebars;
