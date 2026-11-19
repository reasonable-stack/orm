import { beforeEach, expect, test } from 'bun:test';
import * as r from '@reasonable-stack/datetime';
import { embedded, exp, f, from, into, t } from '../src';
import { type Task, minutesAgo, minutesFromNow, task, tasks, users } from './fixtures';
import { type Database, type Equals, assert, suite } from './helpers';

suite('typed fragments', (fresh) => {
  let db: Database;
  let past: Task;
  let future: Task;

  beforeEach(async () => {
    ({ db } = await fresh());

    [past, future] = (await into(tasks).values([
      task({ scheduledTo: minutesAgo(1), attempts: 0 }),
      task({ scheduledTo: minutesFromNow(1), attempts: 2 }),
    ]).insert(db)) as [Task, Task];
  });

  const byAttempts = from(tasks).orderBy([tasks.attempts]);

  test('read as the column type says', async () => {
    const rows = await byAttempts.select({ doubled: f`${tasks.attempts} * 2`.as(t.integer()) }).all(db);
    expect(rows).toEqual([{ doubled: 0 }, { doubled: 4 }]);
  });

  test('are decoded like a column of that type', async () => {
    const rows = await byAttempts.select({
      at: f`${tasks.scheduledTo}`.as(t.timestamp()),
      retried: f`${tasks.attempts} > ${0}`.as(t.boolean()),
    }).all(db);

    expect(rows).toEqual([
      { at: past.scheduledTo, retried: false },
      { at: future.scheduledTo, retried: true },
    ]);
  });

  test('read null when the column type is optional', async () => {
    const rows = await byAttempts.select({ attempts: f`nullif(${tasks.attempts}, ${0})`.as(t.integer().nullable()) }).all(db);
    expect(rows).toEqual([{ attempts: null }, { attempts: 2 }]);
  });

  test('read embedded fields by the fields declared', async () => {
    const events = embedded.many({ kind: t.string(), timestamp: t.timestamp() });
    const rows = await byAttempts.select({ events: f`${tasks.events}`.as(events) }).all(db);

    expect(rows).toEqual([past, future].map(row => ({ events: row.events.map(({ kind, timestamp }) => ({ kind, timestamp })) })));
  });

  test('encode the values they are compared with like a column of that type', async () => {
    expect(await from(tasks).where(f`${tasks.scheduledTo}`.as(t.timestamp()), '<', r.nowUTC()).all(db)).toEqual([past]);
  });

  test('are conditions when read as booleans', async () => {
    expect(await from(tasks).where(f`${tasks.attempts} > ${0}`.as(t.boolean())).all(db)).toEqual([future]);
  });

  test('are decoded inside a collect', async () => {
    const [row] = await from(tasks)
      .groupBy([tasks.status])
      .select({ all: exp.collect({ at: f`${tasks.scheduledTo}`.as(t.timestamp()) }) })
      .all(db);

    expect(row!.all.map(item => item.at).sort((a, b) => a.epoch - b.epoch)).toEqual([past.scheduledTo, future.scheduledTo]);
  });

  test('take instants and dates as parameters, instants in UTC', async () => {
    const at = r.DateTime.parse('2026-11-14T09:34:56.789-03:00');
    const day = r.Date.parse('2026-11-14');

    const row = await from(tasks).limit(1).select({
      at: f`${at}`.as(t.timestamp()),
      day: f`${day}`.as(t.date()),
    }).one(db);

    expect(row).toEqual({ at: at.utc(), day });
  });

  test('only take a column type', () => {
    expect(() => f`1`.as('INTEGER' as never)).toThrow('A fragment is read as a column type, e.g. t.integer(), got INTEGER');
  });

  test('still check the tables they read from', () => {
    expect(() => from(tasks).select({ name: f`${users.name}`.as(t.string()) } as never)).toThrow('"users.name" isn\'t part of the query');
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const untyped = await from(tasks).select({ doubled: f`${tasks.attempts} * 2` }).all(db);
  assert<Equals<typeof untyped, { doubled: unknown }[]>>();

  const typed = await from(tasks).select({
    doubled: f`${tasks.attempts} * 2`.as(t.integer()),
    at: f`now()`.as(t.timestamp()),
    maybe: f`nullif(${tasks.attempts}, ${0})`.as(t.integer().nullable()),
    status: f`${tasks.status}`.as(t.enum(['scheduled', 'queued'])),
  }).all(db);

  assert<Equals<typeof typed, { doubled: number, at: r.DateTime, maybe: number | null, status: 'scheduled' | 'queued' }[]>>();

  from(tasks).where(f`${tasks.attempts} * 2`.as(t.integer()), '>', 2);
  from(tasks).where(exp.not(f`${tasks.attempts} > ${0}`.as(t.boolean())));

  // @ts-expect-error a typed fragment is compared with values of its type
  from(tasks).where(f`${tasks.attempts} * 2`.as(t.integer()), '>', 'two');

  // @ts-expect-error only a typed fragment that reads a boolean is a condition
  from(tasks).where(f`${tasks.attempts} * 2`.as(t.integer()));

  // @ts-expect-error a typed fragment's references must be to the query's table too
  from(tasks).where(f`${users.logins} * 2`.as(t.integer()), '>', 2);

  // @ts-expect-error a fragment is typed once
  f`1`.as(t.integer()).as(t.string());
};
