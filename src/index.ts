import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initDatabase, isMemoryEmpty, closeAllDatabases, getMemoryDir } from './db.js';
import { runBootstrapIfEmpty } from './bootstrap.js';
import { createOperatorTrustRuntime } from './cognitive/operator-trust-loader.js';
import { parseMcpProfile, registerToolsForProfile } from './tool-profiles.js';

const SERVER_INFO = {
  name: 'mem-graph',
  version: '0.3.0',
};

async function main(): Promise<void> {
  // Parse before any database initialization so a misspelled deployment
  // profile cannot create/open state as a side effect.
  const profile = parseMcpProfile();
  process.stderr.write(`[mem-graph] starting; data dir: ${getMemoryDir()}\n`);

  // 1. Initialize the memory database (idempotent schema)
  const memory = initDatabase('memory');

  // 2. Bootstrap seed entries on first run
  if (isMemoryEmpty(memory)) {
    const inserted = runBootstrapIfEmpty(memory);
    if (inserted > 0) {
      process.stderr.write(
        `[mem-graph] bootstrap: inserted ${inserted} seed entries; running wikilink + auto-link pipeline\n`,
      );
      // Bootstrap inserts didn't go through memory_add, so the wikilink/auto-link
      // pipeline didn't fire for them. Run it manually for each bootstrap entry.
      const { extractWikilinks, resolveWikilink, upsertWikilinkSynapse } = await import('./wikilink.js');
      const { autoLinkOnInsert } = await import('./auto-link.js');
      const rows = memory
        .prepare('SELECT id, content, project_id FROM memories')
        .all() as { id: number; content: string; project_id: string }[];
      for (const row of rows) {
        const refs = extractWikilinks(row.content);
        for (const ref of refs) {
          const r = resolveWikilink(memory, ref, row.project_id);
          if (r) upsertWikilinkSynapse(memory, row.id, r.id);
        }
        autoLinkOnInsert(memory, row.id, row.content, row.project_id);
      }
      process.stderr.write(`[mem-graph] bootstrap: graph built\n`);
    }
  } else {
    process.stderr.write(`[mem-graph] bootstrap: skipped (memory table not empty)\n`);
  }

  // 3. Build the MCP server
  const server = new McpServer(SERVER_INFO);

  // Captured once before tool registration; requests cannot select or replace it.
  let operatorTrustRuntime;
  try { operatorTrustRuntime = process.env.MEM_GRAPH_OPERATOR_TRUST_STARTUP ? createOperatorTrustRuntime(JSON.parse(process.env.MEM_GRAPH_OPERATOR_TRUST_STARTUP)) : undefined; } catch { operatorTrustRuntime = undefined; }
  // Full retains the exact legacy registrations; restricted profiles expose
  // only their allowlisted tools.
  registerToolsForProfile(server, profile, { operatorTrustRuntime });

  // 5. Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[mem-graph] connected via stdio\n`);

  // Graceful shutdown
  const cleanup = () => {
    process.stderr.write('[mem-graph] shutting down\n');
    closeAllDatabases();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  process.stderr.write(`[mem-graph] fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
