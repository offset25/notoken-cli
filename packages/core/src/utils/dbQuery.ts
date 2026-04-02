/**
 * Natural language → SQL query builder.
 *
 * Translates phrases like:
 *   "look at items and find sally"        → SELECT * FROM items WHERE ... LIKE '%sally%'
 *   "show me all users"                   → SELECT * FROM users
 *   "count orders"                        → SELECT COUNT(*) FROM orders
 *   "show tables"                         → \dt (postgres) or SHOW TABLES (mysql)
 *   "describe users table"                → \d users or DESCRIBE users
 *   "find orders where total > 100"       → SELECT * FROM orders WHERE total > 100
 */

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", red: "\x1b[31m",
};

export type DbType = "postgres" | "mysql";

export interface DbQueryResult {
  query: string;
  command: string;
  explanation: string;
}

/**
 * Build a SQL query from natural language.
 */
export function buildQuery(
  rawText: string,
  fields: Record<string, unknown>,
  dbType: DbType = "postgres",
): DbQueryResult {
  const text = rawText.toLowerCase();
  const table = (fields.table as string) ?? extractTable(text);
  const search = (fields.search as string) ?? extractSearchTerm(text);

  // "show tables" / "list tables"
  if (text.match(/show\s+tables|list\s+tables|what\s+tables|which\s+tables/)) {
    return dbType === "postgres"
      ? { query: "\\dt", command: buildPsqlCmd(fields, "\\dt"), explanation: "List all tables" }
      : { query: "SHOW TABLES;", command: buildMysqlCmd(fields, "SHOW TABLES;"), explanation: "List all tables" };
  }

  // "describe <table>" / "schema of <table>" / "columns in <table>"
  const describeMatch = text.match(/describe\s+(\w+)|schema\s+(?:of\s+)?(\w+)|columns\s+(?:in\s+|of\s+)?(\w+)|structure\s+(?:of\s+)?(\w+)/);
  if (describeMatch) {
    const t = describeMatch[1] || describeMatch[2] || describeMatch[3] || describeMatch[4];
    return dbType === "postgres"
      ? { query: `\\d ${t}`, command: buildPsqlCmd(fields, `\\d ${t}`), explanation: `Describe table ${t}` }
      : { query: `DESCRIBE ${t};`, command: buildMysqlCmd(fields, `DESCRIBE ${t};`), explanation: `Describe table ${t}` };
  }

  // "count <table>"
  if (text.match(/count|how\s+many/)) {
    if (table) {
      const where = extractWhere(text, table);
      const query = where
        ? `SELECT COUNT(*) FROM ${table} WHERE ${where};`
        : `SELECT COUNT(*) FROM ${table};`;
      return {
        query,
        command: dbType === "postgres" ? buildPsqlCmd(fields, query) : buildMysqlCmd(fields, query),
        explanation: `Count rows in ${table}${where ? ` where ${where}` : ""}`,
      };
    }
  }

  // Search query: "find sally in items" / "look at items find sally"
  if (table && search) {
    const query = `SELECT * FROM ${table} WHERE ${buildSearchWhere(search, table, dbType)} LIMIT 50;`;
    return {
      query,
      command: dbType === "postgres" ? buildPsqlCmd(fields, query) : buildMysqlCmd(fields, query),
      explanation: `Search ${table} for "${search}"`,
    };
  }

  // Search with no table: "find sally" — search across all tables
  if (search && !table) {
    if (dbType === "postgres") {
      // Build a script that searches all tables for the term
      const query = buildSearchAllTablesPg(search);
      return {
        query,
        command: buildPsqlCmd(fields, query),
        explanation: `Search ALL tables for "${search}"`,
      };
    } else {
      const query = buildSearchAllTablesMysql(search, (fields.database as string) ?? "");
      return {
        query,
        command: buildMysqlCmd(fields, query),
        explanation: `Search ALL tables for "${search}"`,
      };
    }
  }

  // Simple select: "show me <table>" / "list <table>" / "all <table>"
  if (table) {
    const where = extractWhere(text, table);
    const limit = extractLimit(text);
    const query = where
      ? `SELECT * FROM ${table} WHERE ${where} LIMIT ${limit};`
      : `SELECT * FROM ${table} LIMIT ${limit};`;
    return {
      query,
      command: dbType === "postgres" ? buildPsqlCmd(fields, query) : buildMysqlCmd(fields, query),
      explanation: `Show rows from ${table}${where ? ` where ${where}` : ""}`,
    };
  }

  // Fallback: raw query if it looks like SQL
  if (text.match(/^(select|insert|update|delete|create|alter|drop)\s/i)) {
    const query = rawText.trim().endsWith(";") ? rawText.trim() : rawText.trim() + ";";
    return {
      query,
      command: dbType === "postgres" ? buildPsqlCmd(fields, query) : buildMysqlCmd(fields, query),
      explanation: "Raw SQL query",
    };
  }

  return {
    query: "",
    command: "",
    explanation: "Could not build a query. Try: show tables, describe <table>, or select * from <table>",
  };
}

// ─── Extractors ──────────────────────────────────────────────────────────────

function extractTable(text: string): string | null {
  // "in <table>" / "from <table>" / "the <table> table" / "my <table>"
  const patterns = [
    /(?:from|in|at|into)\s+(?:the\s+)?(\w+)\s*(?:table)?/,
    /(?:my|the|all)\s+(\w+)\s*(?:table)?/,
    /(?:look\s+at|show|list|query|search|find\s+in)\s+(?:the\s+)?(?:my\s+)?(\w+)/,
    /(\w+)\s+table/,
  ];
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      const t = match[1].toLowerCase();
      // Filter out common non-table words
      if (!["me", "all", "the", "my", "this", "that", "it", "and", "on", "to", "for", "with", "where", "tables", "database"].includes(t)) {
        return t;
      }
    }
  }
  return null;
}

function extractSearchTerm(text: string): string | null {
  // "find <term>" / "has <term>" / "contains <term>" / "with <term>" / "named <term>"
  const patterns = [
    /(?:find|has|contains?|with|named|called|matching|like)\s+(?:the\s+)?['"]?(\w[\w\s]*?)['"]?\s*(?:in|$)/,
    /(?:find|search\s+for|look\s+for)\s+['"]?(\w[\w\s]*?)['"]?\s*(?:in|from|$)/,
    /(?:that\s+has|that\s+contains?)\s+['"]?(\w[\w\s]*?)['"]?/,
    /(?:find\s+(?:the\s+)?(?:one\s+)?(?:that\s+)?(?:has\s+)?)?['"]?(\w+)['"]?\s*$/,
  ];
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      const term = match[1].trim();
      if (term && !["it", "them", "the", "one", "that"].includes(term.toLowerCase())) {
        return term;
      }
    }
  }
  return null;
}

function extractWhere(text: string, table: string): string | null {
  // "where <condition>" — pass through
  const whereMatch = text.match(/where\s+(.+?)(?:\s+limit|\s*$)/);
  if (whereMatch) return whereMatch[1].trim();
  return null;
}

function extractLimit(text: string): number {
  const match = text.match(/(?:limit|top|first|last)\s+(\d+)/);
  if (match) return parseInt(match[1]);
  // "show me 20 users" / "10 orders"
  const numMatch = text.match(/(?:show|list|get)\s+(?:me\s+)?(\d+)/);
  if (numMatch) return parseInt(numMatch[1]);
  return 50;
}

function buildSearchWhere(search: string, table: string, dbType: DbType): string {
  const escaped = escapeSql(search);
  if (dbType === "postgres") {
    // Cast entire row to text and search — works across all columns
    return `${table}::text ILIKE '%${escaped}%'`;
  }
  // MySQL: search common text column names
  return `CONCAT_WS(' ', COALESCE(name,''), COALESCE(title,''), COALESCE(email,''), COALESCE(description,''), COALESCE(username,''), COALESCE(first_name,''), COALESCE(last_name,'')) LIKE '%${escaped}%'`;
}

/**
 * Postgres: search all tables for a term.
 * Casts each row to text and checks with ILIKE.
 */
function buildSearchAllTablesPg(search: string): string {
  const escaped = escapeSql(search);
  // Use a DO block that iterates through all user tables
  return `DO $$
DECLARE
  r RECORD;
  tbl TEXT;
  cnt INTEGER;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    tbl := r.tablename;
    EXECUTE format('SELECT COUNT(*) FROM %I WHERE %I::text ILIKE $1', tbl, tbl) INTO cnt USING '%${escaped}%';
    IF cnt > 0 THEN
      RAISE NOTICE 'Found % match(es) in table: %', cnt, tbl;
    END IF;
  END LOOP;
END $$;`;
}

/**
 * MySQL: search all tables for a term.
 */
function buildSearchAllTablesMysql(search: string, database: string): string {
  const escaped = escapeSql(search);
  // MySQL approach: generate SELECT statements for each table
  return `SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '${database || "DATABASE()"}' AND DATA_TYPE IN ('varchar','text','char','longtext','mediumtext') ORDER BY TABLE_NAME;`;
}

function escapeSql(val: string): string {
  return val.replace(/'/g, "''").replace(/\\/g, "\\\\");
}

// ─── Command builders ────────────────────────────────────────────────────────

function buildPsqlCmd(fields: Record<string, unknown>, query: string): string {
  const db = (fields.database as string) ?? "";
  const host = (fields.host as string) ?? "";
  const user = (fields.user as string) ?? "";
  const parts = ["psql"];
  if (host) parts.push(`-h ${host}`);
  if (user) parts.push(`-U ${user}`);
  if (db) parts.push(db);
  parts.push(`-c ${JSON.stringify(query)}`);
  return parts.join(" ");
}

function buildMysqlCmd(fields: Record<string, unknown>, query: string): string {
  const db = (fields.database as string) ?? "";
  const host = (fields.host as string) ?? "";
  const user = (fields.user as string) ?? "";
  const parts = ["mysql"];
  if (host) parts.push(`-h ${host}`);
  if (user) parts.push(`-u ${user}`);
  if (db) parts.push(db);
  parts.push(`-e ${JSON.stringify(query)}`);
  return parts.join(" ");
}

/**
 * Format query result for display — show the SQL, explain it, then run.
 */
export function formatQueryPlan(result: DbQueryResult): string {
  if (!result.query) return result.explanation;
  const lines: string[] = [];
  lines.push(`\n${c.bold}${c.cyan}── Query Plan ──${c.reset}\n`);
  lines.push(`  ${c.bold}SQL:${c.reset}  ${c.green}${result.query}${c.reset}`);
  lines.push(`  ${c.dim}${result.explanation}${c.reset}`);
  lines.push(`  ${c.dim}Command: ${result.command}${c.reset}`);
  return lines.join("\n");
}
