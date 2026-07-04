import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDatabase, listDatabases } from '../db.js';
import { textResult, errorResult, rowsResult } from '../util.js';

export function registerSqlTools(server: McpServer): void {
  server.tool(
    'sql_query',
    'Execute a SQL query against a loaded database and return the rows. Use sql_execute for INSERT/UPDATE/DELETE/CREATE/DROP.',
    {
      database: z.string().describe('Database name (e.g. "memory").'),
      query: z.string().describe('SQL statement. Use ?-style placeholders for parameters.'),
      params: z
        .array(z.union([z.string(), z.number(), z.null(), z.boolean()]))
        .optional()
        .describe('Positional bind parameters for the ?-placeholders.'),
    },
    async ({ database, query, params }) => {
      const db = getDatabase(database);
      try {
        const stmt = db.prepare(query);
        const rows = params && params.length > 0 ? stmt.all(...params) : stmt.all();
        return rowsResult(rows);
      } catch (e) {
        return errorResult(`SQL error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'sql_execute',
    'Execute a non-SELECT SQL statement (INSERT/UPDATE/DELETE/CREATE/DROP) against a loaded database. Returns the number of changes and last insert rowid.',
    {
      database: z.string().describe('Database name.'),
      statement: z.string().describe('SQL statement. Use ?-style placeholders for parameters.'),
      params: z
        .array(z.union([z.string(), z.number(), z.null(), z.boolean()]))
        .optional()
        .describe('Positional bind parameters for the ?-placeholders.'),
    },
    async ({ database, statement, params }) => {
      const db = getDatabase(database);
      try {
        const stmt = db.prepare(statement);
        const result = params && params.length > 0 ? stmt.run(...params) : stmt.run();
        return textResult(
          JSON.stringify(
            {
              changes: result.changes,
              last_insert_rowid: Number(result.lastInsertRowid),
            },
            null,
            2,
          ),
        );
      } catch (e) {
        return errorResult(`SQL error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'sql_introspect',
    'List the tables, indexes, views, and triggers in a database. Useful for inspecting the schema.',
    {
      database: z.string().describe('Database name.'),
    },
    async ({ database }) => {
      const db = getDatabase(database);
      try {
        const rows = db
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all();
        return rowsResult(rows);
      } catch (e) {
        return errorResult(`SQL error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    'list_databases',
    'List the databases currently loaded by this MCP server.',
    {},
    async () => {
      return rowsResult(listDatabases().map((name) => ({ name })));
    },
  );
}
