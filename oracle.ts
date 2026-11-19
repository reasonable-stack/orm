import { type Infer, embedded, exp, from, into, table, t } from './src';

//
// SCHEMA DEFINITION
//

export type Task = Infer<typeof tasks>;

export const tasks = table('tasks', {
  id: t.uuidv7().generated().primaryKey(),
  parentId: t.uuidv7().nullable(),
  status: t.enum(['scheduled', 'running', 'succeeded', 'failed', 'canceled']),
  attempts: t.integer().unsigned().default(0),
  payload: embedded.one({
    kind: t.string(),
    params: t.record().default({}),
  }),
  events: embedded.many({
    kind: t.string(),
    data: t.record().default({}),
    timestamp: t.timestamp().default(() => Temporal.Now.instant()),
  }),
  scheduledTo: t.timestamp().default(() => Temporal.Now.instant()),
});

//
// DATABASE
//

import * as sqlite from './src/bun-sqlite';

const db = sqlite.connect(':memory:');

//
// INSERTS
//

const task = {
  status: 'scheduled',
  payload: { kind: 'Prune' },
  events: [{ kind: 'Scheduled' }],
} satisfies Infer<typeof tasks, 'insert'>;

const a0: Task[] = await into(tasks)
  .values(task)
  .values([task, task])
  .insert(db);

const a1: Task[] = await into(tasks)
  .values(task)
  .values([task, task])
  .insert(db, { returning: true });

const a2: Pick<Task, 'id' | 'status'>[] = await into(tasks)
  .values(task)
  .values([task, task])
  .insert(db, { returning: [tasks.id, tasks.status] });

const a3: undefined = await into(tasks)
  .values(task)
  .values([task, task])
  .insert(db, { returning: false });

//
// UPDATE
//

const b0: Task[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
  });

const b1: Task[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
    returning: true,
  });

const b2: Pick<Task, 'id' | 'status'>[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
    returning: [tasks.id, tasks.status]
  });

const b3: undefined = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
    returning: false
  });

//
// DELETE
//

const c0: undefined = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .delete(db);

const c1: undefined = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .delete(db, { returning: false });

const c2: Task[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .delete(db, { returning: true });

const c3: Pick<Task, 'id' | 'status'>[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .delete(db, { returning: [tasks.id, tasks.status] });

//
// SELECT - Cardinality is explicit
//

const d0: Task[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .all(db);

const d1: Task | null = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .one(db); // implies limit=1, null when nothing matches

//
// SELECT - WHERE EXPRESSIONS
//

const e0: Task[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .all(db);

const e1: Task[] = await from(tasks)
  .where(exp.and([
    exp(tasks.status, '=', 'scheduled'),
    exp(tasks.scheduledTo, '<=', Temporal.Now.instant()),
  ])) // different syntax, same thing as e0
  .all(db);

const e2: Task[] = await from(tasks)
  .where(tasks.payload.kind, 'IN', ['Prune', 'Purge']) // can address nested fields
  .all(db);

//
// SELECT - PROJECTION
//

const f0: Task[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .all(db); // defaults projection to all columns of the `from` table

const f1: Task[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .select(tasks) // same thing as f0
  .all(db);

const f2: Task[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .select({ ...tasks }) // same thing as f1
  .all(db);

const f3: Pick<Task, 'id' | 'status'>[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .select({ id: tasks.id, status: tasks.status }) // custom projection
  .all(db);

const f4: Task['id'][] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .select(tasks.id) // unwrapped column value
  .all(db);

//
// SELECT - COMMON PROJECTION
//

const g0: number = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .count(db);

const g1: boolean = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .exists(db);

//
// GROUP BY
//

const h0: {
  status: Task['status'],
  count: number,
  totalAttempts: number,
  minAttempts: number,
  avgAttempts: number,
  maxAttempts: number,
}[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
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

const h1: {
  kind: Task['payload']['kind'],
  status: Task['status'],
  count: number,
}[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .groupBy([tasks.payload.kind, tasks.status])
  .select({
    kind: tasks.payload.kind,
    status: tasks.status,
    count: exp.count(tasks.id),
  })
  .all(db);

//
// HAVING
//

const i0: {
  kind: Task['payload']['kind'],
  status: Task['status'],
  count: number,
}[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .groupBy([tasks.payload.kind, tasks.status])
  .having('count', '>', 1)
  .having('count', '<', 10)
  .select({
    kind: tasks.payload.kind,
    status: tasks.status,
    count: exp.count(tasks.id),
  })
  .all(db);

const i1: {
  kind: Task['payload']['kind'],
  status: Task['status'],
  count: number,
}[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .groupBy([tasks.payload.kind, tasks.status])
  .having(exp.and([
    exp('count', '>=', 1), // `count` refers to the projection column
    exp('count', '<=', 10)
  ])) // different syntax, same thing as i0
  .select({
    kind: tasks.payload.kind,
    status: tasks.status,
    count: exp.count(tasks.id),
  })
  .all(db);

//
// ORDER BY
//

const j0: Task[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .orderBy([tasks.status, exp.desc(tasks.scheduledTo)])
  .all(db);

//
// LIMIT AND OFFSET
//

const k0: Task[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<=', Temporal.Now.instant())
  .orderBy([tasks.status, exp.desc(tasks.scheduledTo)])
  .limit(10)
  .offset(10)
  .all(db);

//
// LEFT JOIN
//

const parent = tasks.as('parent');
const child = tasks.as('child');

const l0: Task[] = await from(parent)
  .leftJoin(child, exp(child.parentId, '=', parent.id))
  .where(parent.parentId, 'IS NOT', null)
  .all(db); // returns only the columns of the `from` table

const l1: (Task & { childId: Task['id'] | null })[] = await from(parent)
  .leftJoin(child, exp(child.parentId, '=', parent.id))
  .where(parent.parentId, 'IS', null)
  .select({ ...parent, childId: child.id })
  .all(db);

const l2: (Task & { childId: Task['id'] })[] = await from(parent)
  .innerJoin(child, exp(child.parentId, '=', parent.id))
  .where(parent.parentId, 'IS', null)
  .select({ ...parent, childId: child.id })
  .all(db);

const l3: ({ parentId: Task['id'] | null, childId: Task['id'] })[] = await from(parent)
  .rightJoin(child, exp(child.parentId, '=', parent.id))
  .where(parent.parentId, 'IS', null)
  .select({ parentId: parent.id, childId: child.id })
  .all(db);

//
// AGGREGATIONS
//

const m0: (Task & { children: Task[] })[] = await from(parent)
  .leftJoin(child, exp(child.parentId, '=', parent.id))
  .where(parent.parentId, 'IS', null)
  .groupBy(parent.id) // aggregating next to plain columns requires a groupBy
  .select({ ...parent, children: exp.collect(child) })
  .all(db);

const m1: (Task & { parent: Task | null })[] = await from(child)
  .leftJoin(parent, exp(parent.id, '=', child.parentId))
  .select({ ...child, parent })
  .all(db);

const m2: (Task & { parent: Task })[] = await from(child)
  .innerJoin(parent, exp(parent.id, '=', child.parentId))
  .select({ ...child, parent })
  .all(db);

//
// EXPERIMENTAL MIGRATIONS
//

// migrations.ts
import { alter, create, drop, exec, register, run } from './src/experimental-migrations';

export const migrate = register({
  '0001': async (db) => {
    await create.table(tasks).run(db);
    await create.index('tasks_status_scheduled_to_idx', {
      table: 'tasks',
      columns: ['status', ['scheduled_to', 'DESC']], // column names, verbatim
      where: `status = 'scheduled'`
    }).run(db);
    await create.index('tasks_idempotency_key_idx', {
      table: 'tasks',
      columns: ['idempotency_key'],
      unique: true,
    }).run(db);
  },
  '0002': async (db) => {
    await alter.table('tasks')
      .addColumn('created_by', t.uuidv7().nullable().default(null))
      .addColumn('max_attempts', t.integer().default(3), { backfill: 3 })
      .renameColumn('inserted_at', 'created_at')
      .dropColumn('updated_at')
      .run(db);
  },
  '0003': async (db) => {
    await alter.table('tasks').rename('legacy_tasks').run(db);
  },
  '0004': run([ // returns `(db) => Promise<void>`
    drop.index('tasks_status_scheduled_to_idx'),
    drop.table('legacy_tasks'),
  ]),
  '0005': run([
    exec('INSERT INTO tasks (id, status) VALUES (1, \'scheduled\')'),
    exec('INSERT INTO tasks (id, status) VALUES (2, \'scheduled\')')
  ]),
});

await migrate(db);
