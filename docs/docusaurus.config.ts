import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "SlackHive",
  tagline: "AI agent teams on Slack",
  favicon: "img/favicon.ico",

  url: "https://pelago-labs.github.io",
  baseUrl: "/slackhive/",

  organizationName: "pelago-labs",
  projectName: "slackhive",

  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
          editUrl: "https://github.com/pelago-labs/slackhive/tree/main/docs/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: "light",
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: "SlackHive",
      logo: {
        alt: "SlackHive Logo",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Docs",
        },
        {
          href: "https://github.com/pelago-labs/slackhive",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "light",
      links: [
        {
          title: "Getting Started",
          items: [
            { label: "Introduction", to: "/intro" },
            { label: "Quick Start", to: "/quick-start" },
          ],
        },
        {
          title: "Guides",
          items: [
            { label: "Creating Your First Agent", to: "/guides/create-agent" },
            { label: "Setting Up a Boss Team", to: "/guides/boss-team" },
            { label: "Connecting MCP Servers", to: "/guides/mcp-setup" },
          ],
        },
        {
          title: "Reference",
          items: [
            { label: "CLI Reference", to: "/reference/cli" },
            { label: "Agent Fields", to: "/reference/agent-fields" },
            {
              label: "GitHub",
              href: "https://github.com/pelago-labs/slackhive",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Pelago Labs.`,
    },
    prism: {
      theme: prismThemes.github,
      additionalLanguages: ["bash", "json", "yaml", "typescript"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
