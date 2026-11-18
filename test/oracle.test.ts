import { beforeEach, expect, test } from 'bun:test';
import * as r from '@reasonable-stack/datetime';
import { exp, from, into, t } from '../src';
import { all, alter, create, drop, exec, migrations } from '../src/experimental-migrations';
import { type Task, type TaskInsert, minutesAgo, minutesFromNow, tasks } from './fixtures';
import { type Database, type Equals, type Expand, assert, suite } from './helpers';

// every behaviour sketched in `oracle.ts`, in the order it sketches them

const task = {
  status: 'scheduled',
  payload: { kind: 'Prune' },
  events: [{ kind: 'scheduled' }],
} satisfies TaskInsert;

const byId = <T extends { id: string }>(rows: T[]) => rows.toSorted((x, y) => x.id.localeCompare(y.id));

suite('oracle: inserts', (fresh) => {
  let db: Database;

  beforeEach(async () => {
    ({ db } = await fresh());
  });

  test('a0: returns every inserted row by default', async () => {
    const a0: Task[] = await into(tasks).values(task).values([task, task]).insert(db);

    expect(a0).toHaveLength(3);
    expect(a0[0]).toMatchObject({ status: 'scheduled', payload: { kind: 'Prune', params: {} }, attempts: 0 });
    expect(byId(await from(tasks).all(db))).toEqual(byId(a0));
  });

  test('a1: returns every inserted row given returning: true', async () => {
    const a1: Task[] = await into(tasks).values(task).values([task, task]).insert(db, { returning: true });

    expect(byId(await from(tasks).all(db))).toEqual(byId(a1));
  });

  test('a2: returns the given columns', async () => {
    const a2: Pick<Task, 'id' | 'status'>[] = await into(tasks).values(task).values([task, task]).insert(db, { returning: [tasks.id, tasks.status] });

    expect(a2.map(row => Object.keys(row).sort())).toEqual([['id', 'status'], ['id', 'status'], ['id', 'status']]);
  });

  test('a3: returns nothing given returning: false', async () => {
    const a3: undefined = await into(tasks).values(task).values([task, task]).insert(db, { returning: false });

    expect(a3).toBeUndefined();
    expect(await from(tasks).count(db)).toBe(3);
  });
});

suite('oracle: updates and deletes', (fresh) => {
  let db: Database;
  let due: Task;
  let later: Task;
  let running: Task;

  beforeEach(async () => {
    ({ db } = await fresh());

    [due, later, running] = (await into(tasks).values([
      { ...task, scheduledTo: minutesAgo(1) },
      { ...task, scheduledTo: minutesFromNow(1) },
      { ...task, status: 'running', scheduledTo: minutesAgo(1) },
    ]).insert(db)) as [Task, Task, Task];
  });

  const query = () => from(tasks)
    .where(tasks.status, '=', 'scheduled')
    .where(tasks.scheduledTo, '<=', r.nowUTC());

  const changes = { set: { status: 'running' }, inc: { attempts: 1 } } as const;

  test('b0: updates the matching rows, returning them by default', async () => {
    const b0: Task[] = await query().update(db, changes);

    expect(b0).toEqual([{ ...due, status: 'running', attempts: 1 }]);
    expect(await from(tasks).where(tasks.id, '=', later.id).one(db)).toEqual(later);
  });

  test('b1: returns them given returning: true', async () => {
    const b1: Task[] = await query().update(db, { ...changes, returning: true });

    expect(b1).toEqual([{ ...due, status: 'running', attempts: 1 }]);
  });

  test('b2: returns the given columns', async () => {
    const b2: Pick<Task, 'id' | 'status'>[] = await query().update(db, { ...changes, returning: [tasks.id, tasks.status] });

    expect(b2).toEqual([{ id: due.id, status: 'running' }]);
  });

  test('b3: returns nothing given returning: false', async () => {
    const b3: undefined = await query().update(db, { ...changes, returning: false });

    expect(b3).toBeUndefined();
    expect(await from(tasks).where(tasks.status, '=', 'running').count(db)).toBe(2);
  });

  test('c0: deletes the matching rows, returning nothing by default', async () => {
    const c0: undefined = await query().delete(db);

    expect(c0).toBeUndefined();
    expect(byId(await from(tasks).all(db))).toEqual(byId([later, running]));
  });

  test('c1: returns nothing given returning: false', async () => {
    const c1: undefined = await query().delete(db, { returning: false });

    expect(c1).toBeUndefined();
    expect(await from(tasks).count(db)).toBe(2);
  });

  test('c2: returns the deleted rows given returning: true', async () => {
    const c2: Task[] = await query().delete(db, { returning: true });

    expect(c2).toEqual([due]);
  });

  test('c3: returns the given columns of the deleted rows', async () => {
    const c3: Pick<Task, 'id' | 'status'>[] = await query().delete(db, { returning: [tasks.id, tasks.status] });

    expect(c3).toEqual([{ id: due.id, status: 'scheduled' }]);
  });
});

suite('oracle: selects', (fresh) => {
  let db: Database;
  let sqls: string[];
  let rows: Task[];

  beforeEach(async () => {
    ({ db, sqls } = await fresh());

    rows = await into(tasks).values([
      { ...task, scheduledTo: minutesAgo(3) },
      { ...task, payload: { kind: 'Purge' }, scheduledTo: minutesAgo(2), attempts: 2 },
      { ...task, payload: { kind: 'Notify' }, scheduledTo: minutesAgo(1), attempts: 1 },
      { ...task, scheduledTo: minutesFromNow(1) },
      { ...task, status: 'failed', scheduledTo: minutesAgo(1), attempts: 3 },
    ]).insert(db);

    sqls.length = 0;
  });

  const due = () => from(tasks)
    .where(tasks.status, '=', 'scheduled')
    .where(tasks.scheduledTo, '<=', r.nowUTC());

  test('d0: all returns every matching row', async () => {
    const d0: Task[] = await due().all(db);

    expect(byId(d0)).toEqual(byId(rows.slice(0, 3)));
  });

  test('d1: one returns a single row, limiting the query to 1', async () => {
    const d1: Task | null = await due().orderBy([tasks.scheduledTo]).one(db);

    expect(d1).toEqual(rows[0]!);
    expect(sqls.at(-1)).toMatch(/ LIMIT 1$/);
  });

  test('d1: one returns null when nothing matches', async () => {
    const d1: Task | null = await from(tasks).where(tasks.status, '=', 'canceled').one(db);

    expect(d1).toBeNull();
  });

  test('e0 and e1: chained wheres and exp.and are the same thing', async () => {
    const e0: Task[] = await due().all(db);
    const e1: Task[] = await from(tasks)
      .where(exp.and([
        exp(tasks.status, '=', 'scheduled'),
        exp(tasks.scheduledTo, '<=', r.nowUTC()),
      ]))
      .all(db);

    expect(byId(e1)).toEqual(byId(e0));
  });

  test('e2: wheres address nested fields', async () => {
    const e2: Task[] = await from(tasks).where(tasks.payload.kind, 'IN', ['Prune', 'Purge']).all(db);

    expect(e2.map(row => row.payload.kind).sort()).toEqual(['Prune', 'Prune', 'Prune', 'Purge']);
  });

  test('f0, f1 and f2: the projection defaults to every column of the table', async () => {
    const f0: Task[] = await due().orderBy([tasks.scheduledTo]).all(db);
    const f1: Task[] = await due().orderBy([tasks.scheduledTo]).select(tasks).all(db);
    const f2: Task[] = await due().orderBy([tasks.scheduledTo]).select({ ...tasks }).all(db);

    expect(f1).toEqual(f0);
    expect(f2).toEqual(f0);
  });

  test('f3: a custom projection', async () => {
    const f3: Pick<Task, 'id' | 'status'>[] = await due().orderBy([tasks.scheduledTo]).select({ id: tasks.id, status: tasks.status }).all(db);

    expect(f3).toEqual(rows.slice(0, 3).map(({ id, status }) => ({ id, status })));
  });

  test('f4: a single column, unwrapped', async () => {
    const f4: Task['id'][] = await due().orderBy([tasks.scheduledTo]).select(tasks.id).all(db);

    expect(f4).toEqual(rows.slice(0, 3).map(row => row.id));
  });

  test('f4: a single column, unwrapped, with one', async () => {
    expect(await due().orderBy([tasks.scheduledTo]).select(tasks.payload.kind).one(db)).toBe('Prune');
    expect(await from(tasks).where(tasks.status, '=', 'canceled').select(tasks.id).one(db)).toBeNull();
  });

  test('g0: count counts the matching rows', async () => {
    const g0: number = await due().count(db);

    expect(g0).toBe(3);
  });

  test('g1: exists tells whether any row matches', async () => {
    const g1: boolean = await due().exists(db);

    expect(g1).toBe(true);
    expect(await from(tasks).where(tasks.status, '=', 'canceled').exists(db)).toBe(false);
  });

  test('j0: orders by many columns, each ascending unless told', async () => {
    const j0: Task[] = await from(tasks)
      .where(tasks.scheduledTo, '<=', r.nowUTC())
      .orderBy([tasks.status, [tasks.scheduledTo, 'DESC']])
      .all(db);

    expect(j0).toEqual([rows[4]!, rows[2]!, rows[1]!, rows[0]!]);
  });

  test('k0: limit and offset', async () => {
    const k0: Task[] = await from(tasks)
      .orderBy([tasks.status, [tasks.scheduledTo, 'DESC']])
      .limit(2)
      .offset(1)
      .all(db);

    expect(k0).toEqual([rows[3]!, rows[2]!]);
  });
});

suite('oracle: group by and having', (fresh) => {
  let db: Database;

  beforeEach(async () => {
    ({ db } = await fresh());

    await into(tasks).values([
      { ...task, attempts: 1 },
      { ...task, attempts: 3 },
      { ...task, payload: { kind: 'Purge' }, attempts: 2 },
      { ...task, status: 'failed', attempts: 3 },
      { ...task, scheduledTo: minutesFromNow(1) },
    ]).insert(db);
  });

  const due = () => from(tasks)
    .where(tasks.status, '=', 'scheduled')
    .where(tasks.scheduledTo, '<=', r.nowUTC());

  test('h0: aggregates per group', async () => {
    const h0 = await due()
      .groupBy(tasks.status)
      .select({
        status: tasks.status,
        count: exp.count(tasks.id),
        totalAttempts: exp.sum(tasks.attempts),
        minAttempts: exp.min(tasks.attempts),
        avgAttempts: exp.avg(tasks.attempts),
        maxAttempts: exp.max(tasks.attempts),
      })
      .all(db);

    expect(h0).toEqual([{ status: 'scheduled', count: 3, totalAttempts: 6, minAttempts: 1, avgAttempts: 2, maxAttempts: 3 }]);
  });

  test('h1: groups by many columns, nested fields included', async () => {
    const h1 = await due()
      .groupBy([tasks.payload.kind, tasks.status])
      .orderBy([tasks.payload.kind])
      .select({ kind: tasks.payload.kind, status: tasks.status, count: exp.count(tasks.id) })
      .all(db);

    expect(h1).toEqual([
      { kind: 'Prune', status: 'scheduled', count: 2 },
      { kind: 'Purge', status: 'scheduled', count: 1 },
    ]);
  });

  test('i0 and i1: having by a key of the projection, chained or in exp', async () => {
    const i0 = await due()
      .groupBy([tasks.payload.kind, tasks.status])
      .having('count', '>', 1)
      .having('count', '<', 10)
      .select({ kind: tasks.payload.kind, status: tasks.status, count: exp.count(tasks.id) })
      .all(db);

    const i1 = await due()
      .groupBy([tasks.payload.kind, tasks.status])
      .having(exp.and([exp('count', '>=', 2), exp('count', '<=', 10)]))
      .select({ kind: tasks.payload.kind, status: tasks.status, count: exp.count(tasks.id) })
      .all(db);

    expect(i0).toEqual([{ kind: 'Prune', status: 'scheduled', count: 2 }]);
    expect(i1).toEqual(i0);
  });
});

suite('oracle: joins and aggregations', (fresh) => {
  let db: Database;
  let a: Task;
  let b: Task;
  let children: Task[];

  const parent = tasks.as('parent');
  const child = tasks.as('child');

  beforeEach(async () => {
    ({ db } = await fresh());

    [a, b] = (await into(tasks).values([{ ...task, payload: { kind: 'a' } }, { ...task, payload: { kind: 'b' } }]).insert(db)) as [Task, Task];
    children = await into(tasks).values([{ ...task, parentId: a.id }, { ...task, parentId: a.id }]).insert(db);
  });

  test('l0: a left join still returns the rows of the queried table only', async () => {
    const l0: Task[] = await from(parent)
      .leftJoin(child, exp(child.parentId, '=', parent.id))
      .where(parent.parentId, 'IS NOT', null)
      .all(db);

    expect(byId(l0)).toEqual(byId(children));
  });

  test('l1: columns of a left-joined table read null where it has no match', async () => {
    const l1: (Task & { childId: Task['id'] | null })[] = await from(parent)
      .leftJoin(child, exp(child.parentId, '=', parent.id))
      .where(parent.parentId, 'IS', null)
      .select({ ...parent, childId: child.id })
      .all(db);

    const byChild = <T extends { id: string, childId: string | null }>(rows: T[]) => rows.toSorted((x, y) => `${x.id}:${x.childId}`.localeCompare(`${y.id}:${y.childId}`));

    expect(byChild(l1)).toEqual(byChild([
      ...children.map(row => ({ ...a, childId: row.id })),
      { ...b, childId: null },
    ]));
  });

  test('l2: an inner join leaves out the rows without a match', async () => {
    const l2: (Task & { childId: Task['id'] })[] = await from(parent)
      .innerJoin(child, exp(child.parentId, '=', parent.id))
      .where(parent.parentId, 'IS', null)
      .select({ ...parent, childId: child.id })
      .all(db);

    expect(l2.map(row => row.childId).sort()).toEqual(children.map(row => row.id).sort());
    expect(l2.every(row => row.id === a.id)).toBe(true);
  });

  test('l3: a right join reads every row of the joined table', async () => {
    const l3: { parentId: Task['id'] | null, childId: Task['id'] }[] = await from(parent)
      .rightJoin(child, exp(child.parentId, '=', parent.id))
      .where(child.parentId, 'IS', null)
      .select({ parentId: parent.id, childId: child.id })
      .all(db);

    expect(l3.toSorted((x, y) => x.childId.localeCompare(y.childId))).toEqual([a, b].map(row => ({ parentId: null, childId: row.id })).toSorted((x, y) => x.childId.localeCompare(y.childId)));
  });

  test('m0: collects the children of every parent', async () => {
    const m0: (Task & { children: Task[] })[] = await from(parent)
      .leftJoin(child, exp(child.parentId, '=', parent.id))
      .where(parent.parentId, 'IS', null)
      .groupBy(parent.id)
      .orderBy([parent.payload.kind])
      .select({ ...parent, children: exp.collect(child) })
      .all(db);

    expect(m0.map(row => ({ ...row, children: byId(row.children) }))).toEqual([
      { ...a, children: byId(children) },
      { ...b, children: [] },
    ]);
  });

  test('m0: refuses to collect without a groupBy', async () => {
    const query = from(parent)
      .leftJoin(child, exp(child.parentId, '=', parent.id))
      .select({ ...parent, children: exp.collect(child) });

    await expect(query.all(db)).rejects.toThrow('needs a groupBy');
  });

  test('m1: a selected left-joined table reads as an object, or null', async () => {
    const m1: (Task & { parent: Task | null })[] = await from(child)
      .leftJoin(parent, exp(parent.id, '=', child.parentId))
      .select({ ...child, parent })
      .all(db);

    expect(byId(m1)).toEqual(byId([
      { ...a, parent: null },
      { ...b, parent: null },
      ...children.map(row => ({ ...row, parent: a })),
    ]));
  });

  test('m2: a selected inner-joined table reads as an object', async () => {
    const m2: (Task & { parent: Task })[] = await from(child)
      .innerJoin(parent, exp(parent.id, '=', child.parentId))
      .select({ ...child, parent })
      .all(db);

    expect(byId(m2)).toEqual(byId(children.map(row => ({ ...row, parent: a }))));
  });
});

suite('oracle: experimental migrations', (fresh, { columnsOf, indexesOf, tablesOf }) => {
  let db: Database;

  beforeEach(async () => {
    ({ db } = await fresh({ migrate: false }));
  });

  const migrate0001 = async (db: Database) => {
    await create.table(tasks).run(db);
    await create.index('tasks_status_scheduled_to_idx', {
      table: 'tasks',
      columns: ['status', ['scheduled_to', 'DESC']],
      where: `"status" = 'scheduled'`,
    }).run(db);
    await create.index('tasks_created_at_idx', {
      table: 'tasks',
      columns: ['created_at'],
      unique: true,
    }).run(db);
  };

  // the oracle's migrations, made to run against the fixtures' tasks
  const migrate = migrations({
    '0001': migrate0001,
    '0002': async (db) => {
      await alter.table('tasks')
        .addColumn('created_by', t.uuidv7().nullable().default(null))
        .addColumn('retries', t.integer().default(3), { backfill: 3 })
        .renameColumn('created_at', 'inserted_at')
        .dropColumn('updated_at')
        .run(db);
    },
    '0003': async (db) => {
      await alter.table('tasks').rename('legacy_tasks').run(db);
    },
    '0004': all([
      drop.index('tasks_status_scheduled_to_idx'),
      drop.table('legacy_tasks'),
    ]),
    '0005': all([
      exec('CREATE TABLE "things" ("id" INTEGER PRIMARY KEY, "status" TEXT NOT NULL)'),
      exec('INSERT INTO "things" ("id", "status") VALUES (1, \'scheduled\')'),
      exec('INSERT INTO "things" ("id", "status") VALUES (2, \'scheduled\')'),
    ]),
  });

  test('apply in order', async () => {
    await migrate(db);

    expect(await tablesOf(db)).toEqual(['schema_migrations', 'things']);
    expect(await db.execute('SELECT "status" FROM "things" ORDER BY "id"', [])).toEqual([{ status: 'scheduled' }, { status: 'scheduled' }]);
  });

  test('create indexes, ordered and partial', async () => {
    await migrations({ '0001': migrate0001 })(db);

    expect(await indexesOf(db, 'tasks')).toEqual([
      { name: 'tasks_created_at_idx', unique: true, columns: ['created_at'] },
      { name: 'tasks_status_scheduled_to_idx', unique: false, columns: ['status', 'scheduled_to DESC'] },
    ]);
  });

  test('alter a table with rows in it', async () => {
    await migrations({ '0001': migrate0001 })(db);
    await into(tasks).values(task).insert(db);

    await alter.table('tasks')
      .addColumn('created_by', t.uuidv7().nullable().default(null))
      .addColumn('retries', t.integer().default(3), { backfill: 3 })
      .renameColumn('created_at', 'inserted_at')
      .dropColumn('updated_at')
      .run(db);

    const columns = await columnsOf(db, 'tasks');

    expect(columns).toEqual(expect.arrayContaining(['created_by', 'retries', 'inserted_at']));
    expect(columns).not.toContain('created_at');
    expect(columns).not.toContain('updated_at');
    expect((await db.execute('SELECT "created_by", "retries" FROM "tasks"', [])).map(row => [row['created_by'], Number(row['retries'])])).toEqual([[null, 3]]);
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const parent = tasks.as('parent');
  const child = tasks.as('child');

  const h0 = await from(tasks)
    .where(tasks.status, '=', 'scheduled')
    .groupBy(tasks.status)
    .select({
      status: tasks.status,
      count: exp.count(tasks.id),
      totalAttempts: exp.sum(tasks.attempts),
      minAttempts: exp.min(tasks.attempts),
      avgAttempts: exp.avg(tasks.attempts),
      maxAttempts: exp.max(tasks.attempts),
    })
    .all(db);
  assert<Equals<typeof h0, { status: Task['status'], count: number, totalAttempts: number, minAttempts: number, avgAttempts: number, maxAttempts: number }[]>>();

  const i0 = await from(tasks)
    .groupBy([tasks.payload.kind, tasks.status])
    .having('count', '>', 1)
    .select({ kind: tasks.payload.kind, status: tasks.status, count: exp.count(tasks.id) })
    .all(db);
  assert<Equals<typeof i0, { kind: string, status: Task['status'], count: number }[]>>();

  const f1 = await from(tasks).select(tasks).all(db);
  assert<Equals<typeof f1, Task[]>>();

  const f4 = await from(tasks).select(tasks.id).all(db);
  assert<Equals<typeof f4, string[]>>();

  const f4one = await from(tasks).select(tasks.payload.kind).one(db);
  assert<Equals<typeof f4one, string | null>>();

  const nullableOne = await from(tasks).select(tasks.parentId).all(db);
  assert<Equals<typeof nullableOne, (string | null)[]>>();

  const joinedOne = await from(parent).leftJoin(child, exp(child.parentId, '=', parent.id)).select(child.id).all(db);
  assert<Equals<typeof joinedOne, (string | null)[]>>();

  const counted = await from(tasks).groupBy(tasks.status).select(exp.count(tasks.id)).all(db);
  assert<Equals<typeof counted, number[]>>();

  // a whole table selected on its own reads like the default projection does:
  // its columns null when its row may be missing
  const selectedTable = await from(child).innerJoin(parent, exp(parent.id, '=', child.parentId)).select(parent).all(db);
  assert<Equals<typeof selectedTable, Task[]>>();

  const selectedMissing = await from(child).leftJoin(parent, exp(parent.id, '=', child.parentId)).select(parent).all(db);
  assert<Equals<typeof selectedMissing, Expand<{ [K in keyof Task]: Task[K] | null }>[]>>();

  const m0 = await from(parent)
    .leftJoin(child, exp(child.parentId, '=', parent.id))
    .groupBy(parent.id)
    .select({ ...parent, children: exp.collect(child) })
    .all(db);
  assert<Equals<Expand<(typeof m0)[number]>, Expand<Task & { children: Task[] }>>>();

  // @ts-expect-error a single column is a column of the query's tables
  from(tasks).select(parent.id);
};
