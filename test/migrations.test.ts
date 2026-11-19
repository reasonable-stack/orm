import { beforeEach, describe, expect, test } from 'bun:test';
import { from, into, t, table } from '../src';
import { alter, create, createMigrator, drop, exec, file, run } from '../src/experimental-migrations';
import { migrate, task, tasks } from './fixtures';
import { type Database, suite } from './helpers';

// reads the schema back from the database's own catalog
suite('createMigrator', (fresh, { name, columnsOf, indexesOf }) => {
  let db: Database;
  let sqls: string[];

  const applied = async () => (await db.execute('SELECT "id", "timestamp" FROM "schema_migrations" ORDER BY "id"', []));

  beforeEach(async () => {
    ({ db, sqls } = await fresh({ migrate: false }));
  });

  test('create tables, with snake_cased column names', async () => {
    await migrate(db);

    expect(await columnsOf(db, 'tasks')).toEqual(['id', 'parent_id', 'status', 'attempts', 'max_attempts', 'payload', 'events', 'created_at', 'updated_at', 'scheduled_to']);
    expect(await columnsOf(db, 'users')).toEqual(['id', 'name', 'email', 'logins', 'created_at', 'updated_at', 'last_logged_in_at']);
  });

  test('create indexes', async () => {
    await migrate(db);

    expect(await indexesOf(db, 'tasks')).toEqual([{ name: 'tasks_status_scheduled_to_idx', unique: false, columns: ['status', 'scheduled_to'] }]);
  });

  test('create unique indexes', async () => {
    await migrate(db);

    expect(await indexesOf(db, 'users')).toEqual([{ name: 'users_email_idx', unique: true, columns: ['email'] }]);
  });

  test('are tracked in schema_migrations', async () => {
    await migrate(db);

    const rows = await applied();

    expect(rows.map(row => row['id'])).toEqual(['0001', '0002']);
    expect(rows.every(row => row['timestamp'] !== null)).toBe(true);
  });

  test('are applied once', async () => {
    await migrate(db);
    await migrate(db);

    expect(await applied()).toHaveLength(2);
  });

  test('apply only the pending ones, in order', async () => {
    const ran: string[] = [];

    await createMigrator({
      '0001': async () => { ran.push('0001'); },
    })(db);

    await createMigrator({
      '0003': async () => { ran.push('0003'); },
      '0001': async () => { ran.push('0001'); },
      '0002': async () => { ran.push('0002'); },
    })(db);

    expect(ran).toEqual(['0001', '0002', '0003']);
  });

  test('stop at the first failure, keeping the ones before it', async () => {
    const ran: string[] = [];

    const failing = createMigrator({
      '0001': async () => { ran.push('0001'); },
      '0002': async () => { throw new Error('boom'); },
      '0003': async () => { ran.push('0003'); },
    });

    await expect(failing(db)).rejects.toThrow('boom');

    expect(ran).toEqual(['0001']);
    expect((await applied()).map(row => row['id'])).toEqual(['0001']);
  });

  test('roll back the statements of a failed migration', async () => {
    const failing = createMigrator({
      '0001': async (db) => {
        await create.table(tasks).run(db);
        throw new Error('boom');
      },
    });

    await expect(failing(db)).rejects.toThrow('boom');

    expect(await columnsOf(db, 'tasks')).toEqual([]);
    expect(await applied()).toEqual([]);
  });

  test('run every statement of a SQL file, then data migrations', async () => {
    await createMigrator({
      '0001': run([
        file('test/sql/things.sql'),
        exec('UPDATE "things" SET "body" = "body" || \'!\''),
      ]),
    })(db);

    expect(await columnsOf(db, 'things')).toEqual(['id', 'body']);
    expect(await db.execute('SELECT "body" FROM "things"', [])).toEqual([{ body: 'a; b!' }]);
    expect(sqls).toEqual(expect.arrayContaining([
      expect.stringMatching(/^-- two statements[\s\S]{0,}CREATE TABLE "things" \("id" INTEGER PRIMARY KEY, "body" TEXT NOT NULL\)$/),
      'INSERT INTO "things" ("id", "body") VALUES (1, \'a; b\')',
    ]));
  });

  test('read a SQL file from a URL', async () => {
    await file(new URL('./sql/things.sql', import.meta.url)).run(db);
    expect(await columnsOf(db, 'things')).toEqual(['id', 'body']);
  });

  test('roll back every statement of a failed SQL file', async () => {
    await expect(createMigrator({ '0001': run([file('test/sql/failing.sql')]) })(db)).rejects.toThrow('nope');

    expect(await columnsOf(db, 'things')).toEqual([]);
    expect(await applied()).toEqual([]);
  });

  test('skip a SQL file with nothing but comments', async () => {
    const count = sqls.length;
    await file('test/sql/comments.sql').run(db);
    expect(sqls).toHaveLength(count);
  });

  test.skipIf(name !== 'bun-postgres')("keep a dollar-quoted body's semicolons in its statement", async () => {
    await file('test/sql/function.sql').run(db);
    expect(await db.execute('SELECT "body" FROM "things" ORDER BY "id"', [])).toEqual([{ body: 'a' }, { body: 'b' }]);
  });

  test("refuse a SQL file that doesn't exist", async () => {
    await expect(file('test/sql/missing.sql').run(db)).rejects.toThrow('ENOENT');
  });
});

suite('run', (fresh) => {
  let db: Database;

  beforeEach(async () => {
    ({ db } = await fresh({ migrate: false }));
  });

  test('runs statements and migrations in order', async () => {
    const ran: string[] = [];

    await run([
      exec('CREATE TABLE "things" ("id" INTEGER, "body" TEXT)'),
      async (db) => {
        ran.push('fn');
        await exec('INSERT INTO "things" ("id", "body") VALUES (1, \'a\')').run(db);
      },
      exec('UPDATE "things" SET "body" = \'b\''),
    ])(db);

    expect(ran).toEqual(['fn']);
    expect(await db.execute('SELECT "body" FROM "things"', [])).toEqual([{ body: 'b' }]);
  });

  test('stops at the first failure', async () => {
    const migration = run([
      exec('CREATE TABLE "things" ("id" INTEGER)'),
      exec('INSERT INTO "nope" ("id") VALUES (1)'),
      exec('DROP TABLE "things"'),
    ]);

    await expect(migration(db)).rejects.toThrow();
    expect(await db.execute('SELECT COUNT(*) AS "n" FROM "things"', [])).toHaveLength(1);
  });

  test('runs nothing given nothing', async () => {
    await run([])(db);
  });
});

suite('exec', (fresh) => {
  let db: Database;

  beforeEach(async () => {
    ({ db } = await fresh({ migrate: false }));
  });

  test('runs a statement, ignoring semicolons in quotes and comments', async () => {
    await exec('CREATE TABLE "things" ("id" INTEGER, "body" TEXT); -- a trailing; comment').run(db);
    await exec('INSERT INTO "things" ("id", "body") VALUES (1, \'a; \'\'b\'\'\') /* c; */;').run(db);

    expect(await db.execute('SELECT "body" FROM "things"', [])).toEqual([{ body: "a; 'b'" }]);
  });

  test('takes parameters', async () => {
    const { placeholder } = db.dialect;

    await exec('CREATE TABLE "things" ("id" INTEGER, "body" TEXT)').run(db);
    await exec(`INSERT INTO "things" ("id", "body") VALUES (${placeholder(1)}, ${placeholder(2)})`, [1, 'a']).run(db);

    expect(await db.execute('SELECT "id", "body" FROM "things"', [])).toEqual([{ id: expect.anything(), body: 'a' }]);
  });

  test('refuses more than one statement', async () => {
    await expect(exec('CREATE TABLE "things" ("id" INTEGER); DROP TABLE "things"').run(db))
      .rejects.toThrow('"exec" runs a single statement, got 2: run a script with "file"');
  });
});

suite('create.index', (fresh, { name, indexesOf }) => {
  let db: Database;

  beforeEach(async () => {
    ({ db } = await fresh({ migrate: false }));
    await create.table(tasks).run(db);
  });

  test('orders columns as told', async () => {
    await create.index('tasks_status_scheduled_to_idx', { table: 'tasks', columns: ['status', ['scheduled_to', 'DESC']] }).run(db);

    expect(await indexesOf(db, 'tasks')).toEqual([{ name: 'tasks_status_scheduled_to_idx', unique: false, columns: ['status', 'scheduled_to DESC'] }]);
  });

  test('puts nulls first or last, as told', async () => {
    await create.index('tasks_status_scheduled_to_idx', {
      table: 'tasks',
      columns: [['status', 'ASC NULLS FIRST'], ['scheduled_to', 'DESC NULLS LAST']],
    }).run(db);

    // sqlite always puts nulls first ascending and last descending
    const columns = name === 'bun-sqlite'
      ? ['status', 'scheduled_to DESC']
      : ['status NULLS FIRST', 'scheduled_to DESC NULLS LAST'];

    expect(await indexesOf(db, 'tasks')).toEqual([{ name: 'tasks_status_scheduled_to_idx', unique: false, columns }]);
  });

  test.skipIf(name !== 'bun-postgres')('puts nulls where postgres does by default, as told', async () => {
    await create.index('tasks_status_scheduled_to_idx', {
      table: 'tasks',
      columns: [['status', 'ASC NULLS LAST'], ['scheduled_to', 'DESC NULLS FIRST']],
    }).run(db);

    expect(await indexesOf(db, 'tasks')).toEqual([{ name: 'tasks_status_scheduled_to_idx', unique: false, columns: ['status', 'scheduled_to DESC'] }]);
  });

  test.skipIf(name !== 'bun-sqlite')('refuses to put nulls where sqlite never does', async () => {
    const index = (direction: 'ASC NULLS LAST' | 'DESC NULLS FIRST') =>
      create.index('tasks_status_idx', { table: 'tasks', columns: [['status', direction]] }).run(db);

    await expect(index('ASC NULLS LAST')).rejects.toThrow('sqlite has no equivalent for "ASC NULLS LAST" in an index: it puts nulls first ascending, and last descending');
    await expect(index('DESC NULLS FIRST')).rejects.toThrow('sqlite has no equivalent for "DESC NULLS FIRST" in an index: it puts nulls first ascending, and last descending');
    expect(await indexesOf(db, 'tasks')).toEqual([]);
  });

  test('covers only the rows matching its condition', async () => {
    const things = table('things', { key: t.string(), status: t.string() });
    await create.table(things).run(db);
    await create.index('things_key_idx', { table: 'things', columns: ['key'], unique: true, where: `"status" = 'live'` }).run(db);

    await into(things).values([{ key: 'a', status: 'live' }, { key: 'a', status: 'dead' }, { key: 'a', status: 'dead' }]).insert(db);

    await expect(into(things).values({ key: 'a', status: 'live' }).insert(db)).rejects.toThrow();
    expect(await from(things).count(db)).toBe(3);
  });

  test('can be skipped when it exists', async () => {
    const index = create.index('tasks_status_idx', { table: 'tasks', columns: ['status'] });

    await index.run(db);
    await expect(index.run(db)).rejects.toThrow();
    await create.index('tasks_status_idx', { table: 'tasks', columns: ['status'], ifNotExists: true }).run(db);

    expect(await indexesOf(db, 'tasks')).toHaveLength(1);
  });

  test('takes column names verbatim', async () => {
    await create.index('tasks_scheduled_to_idx', { table: 'tasks', columns: ['scheduled_to'] }).run(db);

    expect(await indexesOf(db, 'tasks')).toEqual([{ name: 'tasks_scheduled_to_idx', unique: false, columns: ['scheduled_to'] }]);
  });

  // sqlite reads a double-quoted name that's no column as a string, rather
  // than refusing it
  test.skipIf(name !== 'bun-postgres')("refuses the keys of a table's definition", async () => {
    await expect(create.index('tasks_scheduled_to_idx', { table: 'tasks', columns: ['scheduledTo'] }).run(db)).rejects.toThrow();
  });

  test('refuses unknown directions and empty column lists', () => {
    expect(() => create.index('x', { table: 'tasks', columns: [['status', 'UP' as never]] })).toThrow('Unknown direction "UP", expected one of ASC, DESC, ASC NULLS FIRST, ASC NULLS LAST, DESC NULLS FIRST, DESC NULLS LAST');
    expect(() => create.index('x', { table: 'tasks', columns: [] })).toThrow('"x" must index at least one column');
  });
});

describe('create.table', () => {
  test('takes a whole table', () => {
    expect(() => create.table(tasks.pick(['id']))).toThrow('"create.table" takes a whole table');
  });
});

suite('alter.table', (fresh, { columnsOf, tablesOf, indexesOf }) => {
  let db: Database;

  const read = async (sql: string) => await db.execute(sql, []);

  beforeEach(async () => {
    ({ db } = await fresh());
    await into(tasks).values([task(), task()]).insert(db);
  });

  test('adds a nullable column, null for the rows already there', async () => {
    await alter.table('tasks').addColumn('created_by', t.uuidv7().nullable()).run(db);

    expect(await columnsOf(db, 'tasks')).toContain('created_by');
    expect(await read('SELECT "created_by" FROM "tasks"')).toEqual([{ created_by: null }, { created_by: null }]);
  });

  test('backfills a column for the rows already there', async () => {
    await alter.table('tasks').addColumn('retries', t.integer().default(3), { backfill: 5 }).run(db);

    expect((await read('SELECT "retries" FROM "tasks"')).map(row => Number(row['retries']))).toEqual([5, 5]);
  });

  test('backfills a nullable column too', async () => {
    await alter.table('tasks').addColumn('note', t.text().nullable(), { backfill: 'legacy' }).run(db);

    expect(await read('SELECT "note" FROM "tasks"')).toEqual([{ note: 'legacy' }, { note: 'legacy' }]);
  });

  test('backfills with values encoded like the column stores them', async () => {
    await alter.table('tasks').addColumn('flagged', t.boolean(), { backfill: true }).run(db);

    const flagged = table('tasks', { id: t.uuidv7().generated().primaryKey(), flagged: t.boolean() });

    expect((await from(flagged).select({ flagged: flagged.flagged }).all(db))).toEqual([{ flagged: true }, { flagged: true }]);
  });

  test('refuses a required column without a backfill', () => {
    expect(() => alter.table('tasks').addColumn('retries', t.integer().default(3)))
      .toThrow('"retries" isn\'t nullable, so it needs a backfill for the rows already in "tasks"');
  });

  test('renames a column', async () => {
    await alter.table('tasks').renameColumn('scheduled_to', 'run_at').run(db);

    expect(await columnsOf(db, 'tasks')).toContain('run_at');
    expect(await columnsOf(db, 'tasks')).not.toContain('scheduled_to');
  });

  test('drops a column', async () => {
    await alter.table('tasks').dropColumn('updated_at').run(db);

    expect(await columnsOf(db, 'tasks')).not.toContain('updated_at');
  });

  test('renames the table', async () => {
    await alter.table('tasks').rename('legacy_tasks').run(db);

    expect(await tablesOf(db)).toContain('legacy_tasks');
    expect(await tablesOf(db)).not.toContain('tasks');
  });

  test('applies every change, in order', async () => {
    await alter.table('tasks')
      .addColumn('created_by', t.uuidv7().nullable())
      .addColumn('max_retries', t.integer().default(3), { backfill: 3 })
      .renameColumn('created_at', 'inserted_at')
      .dropColumn('updated_at')
      .rename('jobs')
      .run(db);

    const columns = await columnsOf(db, 'jobs');

    expect(columns).toEqual(expect.arrayContaining(['created_by', 'max_retries', 'inserted_at']));
    expect(columns).not.toContain('created_at');
    expect(columns).not.toContain('updated_at');
    expect(await indexesOf(db, 'jobs')).toHaveLength(1);
  });

  test('is immutable', async () => {
    const base = alter.table('tasks').addColumn('a', t.text().nullable());

    base.addColumn('b', t.text().nullable());
    await base.run(db);

    expect(await columnsOf(db, 'tasks')).toContain('a');
    expect(await columnsOf(db, 'tasks')).not.toContain('b');
  });
});

suite('drop', (fresh, { tablesOf, indexesOf }) => {
  let db: Database;

  beforeEach(async () => {
    ({ db } = await fresh());
  });

  test('drops an index', async () => {
    await drop.index('tasks_status_scheduled_to_idx').run(db);

    expect(await indexesOf(db, 'tasks')).toEqual([]);
  });

  test('drops a table', async () => {
    await drop.table('users').run(db);

    expect(await tablesOf(db)).not.toContain('users');
  });

  test('refuses what does not exist, unless told otherwise', async () => {
    await expect(drop.table('nope').run(db)).rejects.toThrow();
    await expect(drop.index('nope').run(db)).rejects.toThrow();

    await drop.table('nope', { ifExists: true }).run(db);
    await drop.index('nope', { ifExists: true }).run(db);
  });
});
