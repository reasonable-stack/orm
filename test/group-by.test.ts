import { beforeEach, describe, expect, test } from 'bun:test';
import * as r from '@reasonable-stack/datetime';
import { exp, from, into, t, table } from '../src';
import { type Status, type Task, minutesAgo, task, tasks, users } from './fixtures';
import { type Database, type Equals, assert, suite } from './helpers';

suite('group by', (fresh) => {
  let db: Database;
  let inserted: Task[];

  beforeEach(async () => {
    ({ db } = await fresh());

    inserted = await into(tasks).values([
      task({ status: 'scheduled', payload: { kind: 'Prune' }, scheduledTo: minutesAgo(5) }),
      task({ status: 'failed', payload: { kind: 'Prune' }, attempts: 3, scheduledTo: minutesAgo(4) }),
      task({ status: 'failed', payload: { kind: 'Notify' }, attempts: 2, scheduledTo: minutesAgo(3) }),
      task({ status: 'succeeded', payload: { kind: 'Notify' }, attempts: 1, scheduledTo: minutesAgo(2) }),
      task({ status: 'succeeded', payload: { kind: 'Notify' }, attempts: 1, scheduledTo: minutesAgo(1) }),
    ]).insert(db);
  });

  test('counts rows per nested field', async () => {
    const rows = await from(tasks)
      .groupBy([tasks.payload.kind])
      .orderBy([tasks.payload.kind])
      .select({ kind: tasks.payload.kind, count: exp.count(tasks.id) })
      .all(db);

    expect(rows).toEqual([
      { kind: 'Notify', count: 3 },
      { kind: 'Prune', count: 2 },
    ]);
  });

  test('sums a column per group, after filtering', async () => {
    const rows = await from(tasks)
      .where(tasks.status, '!=', 'scheduled')
      .groupBy([tasks.status])
      .orderBy([tasks.status])
      .select({ status: tasks.status, attempts: exp.sum(tasks.attempts) })
      .all(db);

    expect(rows).toEqual([
      { status: 'failed', attempts: 5 },
      { status: 'succeeded', attempts: 2 },
    ]);
  });

  test('groups by many columns', async () => {
    const rows = await from(tasks)
      .groupBy([tasks.status, tasks.payload.kind])
      .orderBy([tasks.status, tasks.payload.kind])
      .select({ status: tasks.status, kind: tasks.payload.kind, count: exp.count(tasks.id) })
      .all(db);

    expect(rows).toEqual([
      { status: 'failed', kind: 'Notify', count: 1 },
      { status: 'failed', kind: 'Prune', count: 1 },
      { status: 'scheduled', kind: 'Prune', count: 1 },
      { status: 'succeeded', kind: 'Notify', count: 2 },
    ]);
  });

  test('aggregates every row without a group by', async () => {
    const rows = await from(tasks).select({ count: exp.count(tasks.id), attempts: exp.sum(tasks.attempts) }).all(db);

    expect(rows).toEqual([{ count: 5, attempts: 7 }]);
  });

  test('counts and sums each value once, given distinct', async () => {
    const row = await from(tasks)
      .select({
        kinds: exp.count.distinct(tasks.payload.kind),
        statuses: exp.count.distinct(tasks.status),
        attempts: exp.sum.distinct(tasks.attempts),
      })
      .one(db);

    expect(row).toEqual({ kinds: 2, statuses: 3, attempts: 6 });
  });

  test('picks the lowest and highest values per group', async () => {
    const rows = await from(tasks)
      .groupBy([tasks.payload.kind])
      .orderBy([tasks.payload.kind])
      .select({ kind: tasks.payload.kind, min: exp.min(tasks.attempts), max: exp.max(tasks.attempts) })
      .all(db);

    expect(rows).toEqual([
      { kind: 'Notify', min: 1, max: 2 },
      { kind: 'Prune', min: 0, max: 3 },
    ]);
  });

  test('picks the lowest and highest timestamps, nested fields and text', async () => {
    const row = await from(tasks)
      .select({
        first: exp.min(tasks.scheduledTo),
        last: exp.max(tasks.scheduledTo),
        kind: exp.min(tasks.payload.kind),
        status: exp.max(tasks.status),
      })
      .one(db);

    expect(row).toEqual({ first: inserted[0]!.scheduledTo, last: inserted[4]!.scheduledTo, kind: 'Notify', status: 'succeeded' });
  });

  test('picks null out of no rows', async () => {
    const row = await from(tasks)
      .where(tasks.status, '=', 'canceled')
      .select({ min: exp.min(tasks.attempts), max: exp.max(tasks.scheduledTo) })
      .one(db);

    expect(row).toEqual({ min: null, max: null });
  });

  test('filters groups with having', async () => {
    const rows = await from(tasks)
      .groupBy([tasks.status])
      .having(exp.count(tasks.id), '>', 1)
      .orderBy([tasks.status])
      .select({ status: tasks.status })
      .all(db);

    expect(rows).toEqual([{ status: 'failed' }, { status: 'succeeded' }]);
  });

  test('ands many havings, and takes conditions', async () => {
    const rows = await from(tasks)
      .groupBy([tasks.status])
      .having(exp.count(tasks.id), '>', 1)
      .having(exp.or([exp(exp.sum(tasks.attempts), '>=', 100), exp(exp.max(tasks.scheduledTo), '<', inserted[3]!.scheduledTo)]))
      .select({ status: tasks.status })
      .all(db);

    expect(rows).toEqual([{ status: 'failed' }]);
  });

  test('groups by a single operand, without a list', async () => {
    const rows = await from(tasks)
      .groupBy(tasks.status)
      .orderBy([tasks.status])
      .select({ status: tasks.status, count: exp.count(tasks.id) })
      .all(db);

    expect(rows).toEqual([
      { status: 'failed', count: 2 },
      { status: 'scheduled', count: 1 },
      { status: 'succeeded', count: 2 },
    ]);
  });

  test('adds up every groupBy', async () => {
    const rows = await from(tasks)
      .groupBy(tasks.status)
      .groupBy([tasks.payload.kind])
      .select({ count: exp.count(tasks.id) })
      .all(db);

    expect(rows).toHaveLength(4);
  });

  test('averages a column per group', async () => {
    const rows = await from(tasks)
      .groupBy(tasks.status)
      .orderBy([tasks.status])
      .select({ status: tasks.status, avg: exp.avg(tasks.attempts) })
      .all(db);

    expect(rows).toEqual([
      { status: 'failed', avg: 2.5 },
      { status: 'scheduled', avg: 0 },
      { status: 'succeeded', avg: 1 },
    ]);
  });

  test('averages fractions, as floats', async () => {
    const row = await from(tasks).where(tasks.payload.kind, '=', 'Notify').select({ avg: exp.avg(tasks.attempts) }).one(db);

    expect(row!.avg).toBeCloseTo(4 / 3);
  });

  test('averages null out of no rows', async () => {
    const row = await from(tasks).where(tasks.status, '=', 'canceled').select({ avg: exp.avg(tasks.attempts) }).one(db);

    expect(row).toEqual({ avg: null });
  });

  test('aggregates the oracle way: count, sum, min, avg and max per group', async () => {
    const rows = await from(tasks)
      .where(tasks.status, '!=', 'scheduled')
      .groupBy(tasks.status)
      .orderBy([tasks.status])
      .select({
        status: tasks.status,
        count: exp.count(tasks.id),
        totalAttempts: exp.sum(tasks.attempts),
        minAttempts: exp.min(tasks.attempts),
        avgAttempts: exp.avg(tasks.attempts),
        maxAttempts: exp.max(tasks.attempts),
      })
      .all(db);

    expect(rows).toEqual([
      { status: 'failed', count: 2, totalAttempts: 5, minAttempts: 2, avgAttempts: 2.5, maxAttempts: 3 },
      { status: 'succeeded', count: 2, totalAttempts: 2, minAttempts: 1, avgAttempts: 1, maxAttempts: 1 },
    ]);
  });

  describe('having, by a key of the projection', () => {
    test('filters groups by an aggregate it selects', async () => {
      const rows = await from(tasks)
        .groupBy(tasks.status)
        .having('count', '>', 1)
        .orderBy([tasks.status])
        .select({ status: tasks.status, count: exp.count(tasks.id) })
        .all(db);

      expect(rows).toEqual([{ status: 'failed', count: 2 }, { status: 'succeeded', count: 2 }]);
    });

    test('is the same after select', async () => {
      const rows = await from(tasks)
        .groupBy(tasks.status)
        .orderBy([tasks.status])
        .select({ status: tasks.status, count: exp.count(tasks.id) })
        .having('count', '>', 1)
        .all(db);

      expect(rows).toEqual([{ status: 'failed', count: 2 }, { status: 'succeeded', count: 2 }]);
    });

    test('ands many havings', async () => {
      const rows = await from(tasks)
        .groupBy([tasks.payload.kind, tasks.status])
        .having('count', '>=', 1)
        .having('count', '<', 2)
        .orderBy([tasks.payload.kind, tasks.status])
        .select({ kind: tasks.payload.kind, status: tasks.status, count: exp.count(tasks.id) })
        .all(db);

      expect(rows).toEqual([
        { kind: 'Notify', status: 'failed', count: 1 },
        { kind: 'Prune', status: 'failed', count: 1 },
        { kind: 'Prune', status: 'scheduled', count: 1 },
      ]);
    });

    test('takes keys inside exp conditions', async () => {
      const rows = await from(tasks)
        .groupBy(tasks.status)
        .having(exp.and([exp('count', '>=', 2), exp('attempts', '<=', 2)]))
        .select({ status: tasks.status, count: exp.count(tasks.id), attempts: exp.sum(tasks.attempts) })
        .all(db);

      expect(rows).toEqual([{ status: 'succeeded', count: 2, attempts: 2 }]);
    });

    test('takes keys of plain columns too', async () => {
      const rows = await from(tasks)
        .groupBy(tasks.status)
        .having('status', '!=', 'failed')
        .orderBy([tasks.status])
        .select({ status: tasks.status })
        .all(db);

      expect(rows).toEqual([{ status: 'scheduled' }, { status: 'succeeded' }]);
    });

    test('encodes values like the field it names', async () => {
      const rows = await from(tasks)
        .groupBy(tasks.status)
        .having('latest', '<', inserted[3]!.scheduledTo)
        .select({ status: tasks.status, latest: exp.max(tasks.scheduledTo) })
        .all(db);

      expect(rows.map(row => row.status).sort()).toEqual(['failed', 'scheduled']);
    });

    test('refuses keys the projection does not have', async () => {
      const query = from(tasks).groupBy(tasks.status).having('nope' as never, '>', 1).select({ status: tasks.status });

      await expect(query.all(db)).rejects.toThrow('"nope" isn\'t a key of the projection');
    });
  });

  describe('aggregates next to plain columns', () => {
    test('need a groupBy', async () => {
      const query = from(tasks).select({ status: tasks.status, count: exp.count(tasks.id) });

      await expect(query.all(db)).rejects.toThrow('"status" isn\'t aggregated, so the query needs a groupBy');
      await expect(query.one(db)).rejects.toThrow('needs a groupBy');
      await expect(query.count(db)).rejects.toThrow('needs a groupBy');
    });

    test('need a groupBy when collected next to a spread table', async () => {
      const query = from(tasks).select({ ...tasks, all: exp.collect(tasks) });

      await expect(query.all(db)).rejects.toThrow('"id" isn\'t aggregated, so the query needs a groupBy');
    });

    test('are fine on their own', async () => {
      expect(await from(tasks).select({ count: exp.count(tasks.id), avg: exp.avg(tasks.attempts) }).all(db)).toEqual([{ count: 5, avg: 7 / 5 }]);
    });

    test('are fine inside expressions that are aggregated as a whole', async () => {
      const row = await from(tasks).select({ latest: exp.coalesce(exp.max(tasks.scheduledTo), inserted[0]!.scheduledTo) }).one(db);

      expect(row).toEqual({ latest: inserted[4]!.scheduledTo });
    });
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const j1 = await from(tasks)
    .groupBy([tasks.payload.kind])
    .select({ kind: tasks.payload.kind, count: exp.count(tasks.id) })
    .all(db);
  assert<Equals<typeof j1, { kind: string; count: number }[]>>();

  const j2 = await from(tasks)
    .where(tasks.status, '!=', 'scheduled')
    .groupBy([tasks.status])
    .select({ status: tasks.status, attempts: exp.sum(tasks.attempts) })
    .all(db);
  assert<Equals<typeof j2, { status: Status; attempts: number }[]>>();

  // @ts-expect-error only numeric columns can be summed
  exp.sum(tasks.status);

  // @ts-expect-error only numeric columns can be summed
  exp.sum.distinct(tasks.status);

  const j3 = await from(tasks)
    .select({
      kinds: exp.count.distinct(tasks.payload.kind),
      attempts: exp.sum.distinct(tasks.attempts),
      fewest: exp.min(tasks.attempts),
      latest: exp.max(tasks.scheduledTo),
      status: exp.max(tasks.status),
      kind: exp.min(tasks.payload.kind),
    })
    .one(db);
  assert<Equals<typeof j3, { kinds: number; attempts: number; fewest: number | null; latest: r.DateTime | null; status: Status | null; kind: string | null } | null>>();

  // @ts-expect-error JSON documents have no order to them
  exp.min(tasks.payload);

  // @ts-expect-error neither do booleans, on postgres
  exp.max(table('flags', { on: t.boolean() }).on);

  const j4 = await from(tasks).groupBy([tasks.status]).having(exp.count(tasks.id), '>', 1).select({ status: tasks.status }).all(db);
  assert<Equals<typeof j4, { status: Status }[]>>();

  // @ts-expect-error having compares like where does
  from(tasks).groupBy([tasks.status]).having(exp.count(tasks.id), '>', 'x');

  // @ts-expect-error having takes references to the query's tables only
  from(tasks).groupBy([tasks.status]).having(exp.count(users.id), '>', 1);

  // @ts-expect-error groupBy takes references to the query's table only
  from(tasks).groupBy([tasks.as('t0').status]);

  // @ts-expect-error a single groupBy takes references to the query's table only
  from(tasks).groupBy(users.id);

  // every group has a row, so its lowest, average and highest values are
  // never null, unless the values themselves may be
  const grouped = await from(tasks)
    .groupBy(tasks.status)
    .select({ min: exp.min(tasks.attempts), avg: exp.avg(tasks.attempts), max: exp.max(tasks.scheduledTo) })
    .all(db);
  assert<Equals<typeof grouped, { min: number; avg: number; max: r.DateTime }[]>>();

  const groupedNullable = await from(users)
    .groupBy(users.name)
    .select({ last: exp.max(users.lastLoggedInAt) })
    .all(db);
  assert<Equals<typeof groupedNullable, { last: r.DateTime | null }[]>>();

  // ...or their table's rows may be missing
  const parent = tasks.as('parent');
  const child = tasks.as('child');
  const joined = await from(parent)
    .leftJoin(child, exp(child.parentId, '=', parent.id))
    .groupBy(parent.id)
    .select({ id: parent.id, min: exp.min(child.attempts), avg: exp.avg(child.attempts), count: exp.count(child.id) })
    .all(db);
  assert<Equals<typeof joined, { id: string; min: number | null; avg: number | null; count: number }[]>>();

  // without a groupBy, there may be no rows to aggregate
  const ungrouped = await from(tasks).select({ min: exp.min(tasks.attempts), avg: exp.avg(tasks.attempts) }).all(db);
  assert<Equals<typeof ungrouped, { min: number | null; avg: number | null }[]>>();

  // @ts-expect-error only numeric columns can be averaged
  exp.avg(tasks.status);

  // having takes a key of the projection, before or after select
  const before = await from(tasks)
    .groupBy(tasks.status)
    .having('count', '>', 1)
    .having(exp.and([exp('count', '>=', 1), exp('count', '<=', 10)]))
    .select({ status: tasks.status, count: exp.count(tasks.id) })
    .all(db);
  assert<Equals<typeof before, { status: Status; count: number }[]>>();

  const after = await from(tasks)
    .groupBy(tasks.status)
    .select({ status: tasks.status, count: exp.count(tasks.id) })
    .having('count', '>', 1)
    .all(db);
  assert<Equals<typeof after, { status: Status; count: number }[]>>();

  // @ts-expect-error after select, having takes the projection's keys only
  from(tasks).groupBy(tasks.status).select({ status: tasks.status }).having('count', '>', 1);

  // @ts-expect-error after select, having compares like the field it names
  from(tasks).groupBy(tasks.status).select({ count: exp.count(tasks.id) }).having('count', '>', 'x');

  // @ts-expect-error a select after having must have the keys it named
  from(tasks).groupBy(tasks.status).having('count', '>', 1).select({ status: tasks.status });

  // @ts-expect-error ...including those named inside exp conditions
  from(tasks).groupBy(tasks.status).having(exp('count', '>', 1)).select({ status: tasks.status });

  // @ts-expect-error keys aren't conditions on rows
  from(tasks).where(exp('count', '>', 1));
};
