/**
 * @fileoverview Built-in memory MCP server source code.
 *
 * This TypeScript source is injected as an inline stdio MCP for every agent.
 * It exposes three tools — list_memories, search_memories, get_memory — that
 * query the agent's memory rows directly from Postgres.
 *
 * The script runs via `tsx` inside the runner container and receives:
 *   DATABASE_URL  — Postgres connection string
 *   MEMORY_AGENT_ID — the agent's UUID (injected by ClaudeHandler)
 *
 * @module runner/memory-mcp
 */

export const MEMORY_MCP_SOURCE = `
import { Pool } from "pg";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const AGENT_ID = process.env.MEMORY_AGENT_ID;

const server = new Server({ name: "memory", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_memories",
      description: "List all memories for this agent. Returns names and a short preview. Optionally filter by type.",
      inputSchema: { type: "object", properties: { type: { type: "string", enum: ["user", "feedback", "project", "reference"], description: "Filter by memory type (optional)" } } },
    },
    {
      name: "search_memories",
      description: "Search memories by keyword across name and content. Use to find relevant past context.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "get_memory",
      description: "Get the full content of a specific memory by name.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
  ],
}));

function text(t) { return { content: [{ type: "text", text: t }] }; }
function err(e) { return { content: [{ type: "text", text: String(e) }], isError: true }; }

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = args ?? {};
  try {
    if (name === "list_memories") {
      const q = a.type
        ? "SELECT type, name, LEFT(content, 300) as preview FROM memories WHERE agent_id = $1 AND type = $2 ORDER BY type, name"
        : "SELECT type, name, LEFT(content, 300) as preview FROM memories WHERE agent_id = $1 ORDER BY type, name";
      const params = a.type ? [AGENT_ID, a.type] : [AGENT_ID];
      const r = await pool.query(q, params);
      if (r.rows.length === 0) return text("No memories found.");
      return text(r.rows.map(row => "[" + row.type + "] " + row.name + "\\n" + row.preview.split("\\n").slice(0, 3).join("\\n")).join("\\n\\n"));
    }
    if (name === "search_memories") {
      const r = await pool.query(
        "SELECT type, name, content FROM memories WHERE agent_id = $1 AND (name ILIKE $2 OR content ILIKE $2) ORDER BY type, name",
        [AGENT_ID, "%" + a.query + "%"]
      );
      if (r.rows.length === 0) return text("No memories found matching \\"" + a.query + "\\".");
      return text(r.rows.map(row => "[" + row.type + "] " + row.name + "\\n\\n" + row.content).join("\\n\\n---\\n\\n"));
    }
    if (name === "get_memory") {
      const r = await pool.query("SELECT type, name, content FROM memories WHERE agent_id = $1 AND name = $2", [AGENT_ID, a.name]);
      if (r.rows.length === 0) return text("Memory \\"" + a.name + "\\" not found.");
      const row = r.rows[0];
      return text("[" + row.type + "] " + row.name + "\\n\\n" + row.content);
    }
    return err("Unknown tool: " + name);
  } catch (e) { return err(e); }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(console.error);
`;
