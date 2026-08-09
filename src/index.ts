import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initDatabase, isMemoryEmpty, closeAllDatabases, getMemoryDir } from './db.js';
import { runBootstrapIfEmpty } from './bootstrap.js';
import { registerSqlTools } from './tools/sql.js';
import { registerMemoryOrientTools } from './tools/memory-orient.js';
import { registerMemorySearchTools } from './tools/memory-search.js';
import { registerMemoryWriteTools } from './tools/memory-write.js';
import { registerMemoryTagTools } from './tools/memory-tags.js';
import { registerMemoryGraphTools } from './tools/memory-graph.js';
import { registerMemoryImportTools } from './tools/memory-import.js';
import { registerCognitiveTools } from './tools/cognitive.js';

const SERVER_INFO = {
  name: 'mem-graph',
  version: '0.3.0',
};

async function main(): Promise<void> {
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

  // 4. Register the 35 tools across 8 groups.
  registerSqlTools(server);              // 4 tools
  registerMemoryOrientTools(server);     // 4 tools
  registerMemorySearchTools(server);     // 5 tools
  registerMemoryWriteTools(server);      // 5 tools
  registerMemoryTagTools(server);        // 2 tools (R2)
  registerMemoryGraphTools(server);      // 6 tools
  registerMemoryImportTools(server);     // 1 tool  (R3)
  registerCognitiveTools(server);        // 8 tools (Cognitive OS)

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
