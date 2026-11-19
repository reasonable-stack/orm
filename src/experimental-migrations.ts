import {
  type Column,
  type ColumnBuilder,
  type ColumnProps,
  type DialectName,
  type IDatabase,
  type Table,
  NAME,
  assertWhole,
  columnsOf,
  encode,
  quote,
  renderColumnDefinition,
  run as runStatement,
  t,
  table,
  validate,
} from './core.js';
import { raise } from './utils.js';

// Migrations name tables and columns the way the database does (snake_case),
// verbatim: they describe the schema as it was when they ran, rather than as
// today's table definitions say it is

// ─── statements ──────────────────────────────────────────────────────────────

type Migration = (db: IDatabase) => Promise<void>;

// something to run against a database, e.g. a statement or a few of them
type Runnable = { run(db: IDatabase): Promise<void> };

const runnable = (fn: Migration): Runnable => ({ run: fn });

const statement = (sql: string, params: unknown[] = []) => ({ sql, params });

// a quoted string or identifier, a dollar-quoted body, a comment, a
// semicolon, or anything else
const TOKENS = /'(?:[^']|''){0,}'|"(?:[^"]|""){0,}"|(\$(?:[A-Za-z_]\w{0,})?\$)[\s\S]{0,}?\1|--[^\n]{0,}|\/\*[\s\S]{0,}?\*\/|;|[^'"$;\-/]+|[\s\S]/g;

const isCode = (token: string) => !token.startsWith('--') && !token.startsWith('/*') && token.trim() !== '';

// splits SQL into its statements, by the semicolons outside of quotes and
// comments, leaving out those with nothing but comments
const statementsOf = (sql: string) => {
  const statements: string[] = [];
  let current = '';
  let code = false;

  for (const [token] of sql.matchAll(TOKENS)) {
    if (token === ';') {
      if (code) statements.push(current.trim());
      current = '';
      code = false;
    } else {
      current += token;
      code ||= isCode(token);
    }
  }

  if (code) statements.push(current.trim());
  return statements;
};

// runs a raw statement, e.g. a data fix. Only one: a prepared statement on
// sqlite would run the first and silently skip the rest
const exec = (sql: string, params: unknown[] = []) => runnable(async (db) => {
  const { length } = statementsOf(sql);
  if (length > 1) throw new Error(`"exec" runs a single statement, got ${length}: run a script with "file"`);

  await runStatement(db, statement(sql, params));
});

// runs every statement of a SQL file, one at a time. A relative path is
// resolved from the working directory, and a URL, e.g. `new URL('./0001.sql',
// import.meta.url)`, from wherever it points
const file = (path: string | URL) => runnable(async (db) => {
  for (const sql of statementsOf(await Bun.file(path).text())) await runStatement(db, statement(sql));
});

// runs statements and migrations one after the other, as a migration
const run = (items: (Runnable | Migration)[]): Migration => async (db) => {
  for (const item of items) await (typeof item === 'function' ? item(db) : item.run(db));
};

// ─── create ──────────────────────────────────────────────────────────────────

const DIRECTIONS = ['ASC', 'DESC', 'ASC NULLS FIRST', 'ASC NULLS LAST', 'DESC NULLS FIRST', 'DESC NULLS LAST'] as const;
type Direction = typeof DIRECTIONS[number];

type IndexOptions = {
  table: string;
  columns: (string | [column: string, direction: Direction])[];
  unique?: boolean;
  // raw SQL, making it a partial index of the rows it's true for
  where?: string;
  ifNotExists?: boolean;
};

// sqlite takes no NULLS FIRST or LAST in an index: it puts nulls first
// ascending, and last descending, so only those are taken there
const directionOf = (dialect: DialectName, direction: Direction) => {
  if (dialect !== 'sqlite' || direction === 'ASC' || direction === 'DESC') return direction;
  if (direction === 'ASC NULLS FIRST') return 'ASC';
  if (direction === 'DESC NULLS LAST') return 'DESC';
  return raise(`sqlite has no equivalent for "${direction}" in an index: it puts nulls first ascending, and last descending`);
};

const indexedColumn = (dialect: DialectName, col: string, direction: Direction) => {
  const dir = directionOf(dialect, direction);
  return dir === 'ASC' ? quote(col) : `${quote(col)} ${dir}`;
};

const createIndex = (name: string, { table, columns, unique = false, where, ifNotExists = false }: IndexOptions) => {
  if (columns.length === 0) raise(`"${name}" must index at least one column`);

  const cols = columns.map(item => {
    const [col, direction] = Array.isArray(item) ? item : [item, 'ASC' as const];
    if (!DIRECTIONS.includes(direction)) raise(`Unknown direction "${direction}", expected one of ${DIRECTIONS.join(', ')}`);
    return [col, direction] as const;
  });

  return runnable(async (db) => {
    const sql = [
      `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quote(name)} ON ${quote(table)}`,
      `(${cols.map(([col, direction]) => indexedColumn(db.dialect.name, col, direction)).join(', ')})`,
      where && `WHERE ${where}`,
    ].filter(Boolean).join(' ');

    await runStatement(db, statement(sql));
  });
};

// a table as its definition says it is today
const createTable = (definition: Table, { ifNotExists = false }: { ifNotExists?: boolean } = {}) => {
  const cols = columnsOf(assertWhole(definition, '"create.table"'));

  return runnable(async (db) => {
    const sql = `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${quote(definition[NAME])} (${cols.map(col => renderColumnDefinition(db.dialect, col)).join(', ')})`;
    await runStatement(db, statement(sql));
  });
};

const create = {
  table: createTable,
  index: createIndex,
};

// ─── alter ───────────────────────────────────────────────────────────────────

// a constant in DDL, where parameters aren't taken
const literal = (db: IDatabase, value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return literal(db, value.toISOString());
  if (value instanceof Uint8Array) {
    const hex = Buffer.from(value).toString('hex');
    return db.dialect.name === 'postgres' ? `'\\x${hex}'` : `X'${hex}'`;
  }
  if (typeof value === 'string') return `'${value.replaceAll('\'', '\'\'')}'`;

  return literal(db, JSON.stringify(value));
};

type Change =
  | { kind: 'add'; col: Column; backfill?: unknown }
  | { kind: 'renameColumn'; from: string; to: string }
  | { kind: 'dropColumn'; name: string }
  | { kind: 'rename'; to: string };

// the statements a change takes, on the table under its current name
const statementsFor = (db: IDatabase, name: string, change: Change) => {
  const table = quote(name);

  switch (change.kind) {
    case 'renameColumn':
      return [statement(`ALTER TABLE ${table} RENAME COLUMN ${quote(change.from)} TO ${quote(change.to)}`)];
    case 'dropColumn':
      return [statement(`ALTER TABLE ${table} DROP COLUMN ${quote(change.name)}`)];
    case 'rename':
      return [statement(`ALTER TABLE ${table} RENAME TO ${quote(change.to)}`)];
    case 'add': {
      const { col } = change;
      const definition = renderColumnDefinition(db.dialect, col);
      if (!('backfill' in change)) return [statement(`ALTER TABLE ${table} ADD COLUMN ${definition}`)];

      const value = encode(db.dialect, col, change.backfill);

      // a nullable column is added empty, then filled in
      if (col.nullable) return [
        statement(`ALTER TABLE ${table} ADD COLUMN ${definition}`),
        statement(`UPDATE ${table} SET ${quote(col.name)} = ${db.dialect.placeholder(1)}`, [value]),
      ];

      // a required one needs a value from the start, which sqlite only takes
      // as a default, and can't drop afterwards
      return [
        statement(`ALTER TABLE ${table} ADD COLUMN ${definition} DEFAULT ${literal(db, value)}`),
        ...db.dialect.name === 'postgres' ? [statement(`ALTER TABLE ${table} ALTER COLUMN ${quote(col.name)} DROP DEFAULT`)] : [],
      ];
    }
  }
};

class AlterTable implements Runnable {
  constructor(private readonly name: string,
              private readonly changes: Change[] = []) { }

  // a column of the given type, filled in for the rows already in the table
  // with `backfill`, which a required column can't do without
  addColumn<P extends ColumnProps>(name: string, type: ColumnBuilder<P>, options?: { backfill: unknown }) {
    const col = { ...type.props, key: name, name } as unknown as Column;

    if (col.primaryKey) raise(`"${name}" can't be added as a primary key`);
    if (col.generated) raise(`"${name}" can't be added as a generated column`);
    if (col.unique) raise(`"${name}" can't be added as a unique column, add a unique index instead`);
    if (!col.nullable && options === undefined) raise(`"${name}" isn't nullable, so it needs a backfill for the rows already in "${this.name}"`);

    const change: Change = options === undefined
      ? { kind: 'add', col }
      : { kind: 'add', col, backfill: validate({ [name]: col }, { [name]: options.backfill })[name] };

    return new AlterTable(this.name, [...this.changes, change]);
  }

  renameColumn(from: string, to: string) {
    return new AlterTable(this.name, [...this.changes, { kind: 'renameColumn', from, to }]);
  }

  dropColumn(name: string) {
    return new AlterTable(this.name, [...this.changes, { kind: 'dropColumn', name }]);
  }

  // later changes apply to the table under its new name
  rename(to: string) {
    return new AlterTable(this.name, [...this.changes, { kind: 'rename', to }]);
  }

  // one statement per change (sqlite takes no more), in order
  async run(db: IDatabase) {
    let name = this.name;

    for (const change of this.changes) {
      for (const stmt of statementsFor(db, name, change)) await runStatement(db, stmt);
      if (change.kind === 'rename') name = change.to;
    }
  }
}

const alter = {
  table: (name: string) => new AlterTable(name),
};

// ─── drop ────────────────────────────────────────────────────────────────────

const dropOf = (kind: 'INDEX' | 'TABLE') => (name: string, { ifExists = false }: { ifExists?: boolean } = {}) =>
  runnable(async (db) => { await runStatement(db, statement(`DROP ${kind} ${ifExists ? 'IF EXISTS ' : ''}${quote(name)}`)); });

const drop = {
  index: dropOf('INDEX'),
  table: dropOf('TABLE'),
};

// ─── migrations ──────────────────────────────────────────────────────────────

const schemaMigrations = table('schema_migrations', {
  id: t.string().primaryKey(),
  timestamp: t.timestamp(),
});

const timestampColumn = columnsOf(schemaMigrations).find(col => col.key === 'timestamp')!;

// applies the pending migrations in the order of their ids, each in a
// transaction of its own, tracking the applied ones in `schema_migrations`
const register = (migrations: Record<string, Migration>): Migration => async (db) => {
  await createTable(schemaMigrations, { ifNotExists: true }).run(db);

  const { dialect } = db;
  const rows = await runStatement(db, statement('SELECT "id" FROM "schema_migrations"'));
  const applied = new Set(rows.map(row => row['id']));

  for (const id of Object.keys(migrations).sort()) {
    if (applied.has(id)) continue;

    await db.transaction(async tx => {
      await migrations[id]!(tx);
      await runStatement(tx, statement(
        `INSERT INTO "schema_migrations" ("id", "timestamp") VALUES (${dialect.placeholder(1)}, ${dialect.placeholder(2)})`,
        [id, encode(dialect, timestampColumn, Temporal.Now.instant())],
      ));
    });
  }
};

export {
  type Migration,
  type Runnable,
  alter,
  create,
  drop,
  exec,
  file,
  register,
  run,
};
