import { beforeEach, describe, expect, test } from 'bun:test';
import { f, from, into, t } from '../src';
import { jane, minutesAgo, task, tasks, users } from './fixtures';
import { type Database, suite } from './helpers';

suite('column types', (fresh, adapter) => {
  let db: Database;
  let params: unknown[][];

  beforeEach(async () => {
    ({ db, params } = await fresh());
  });

  describe('t.uuidv7().generated()', () => {
    test('is generated on insert', async () => {
      const [a, b] = await into(tasks).values([task(), task()]).insert(db);

      expect(a!.id).toBeString();
      expect(a!.id).not.toBe(b!.id);
    });
  });

  describe('t.enum()', () => {
    test('round-trips its values', async () => {
      const [row] = await into(tasks).values(task({ status: 'queued' })).insert(db);

      expect(row!.status).toBe('queued');
    });

    test('rejects values outside of it', async () => {
      const row = JSON.parse('{"status":"nope","payload":{"kind":"Prune"},"events":[]}');

      await expect(into(tasks).values(row).insert(db)).rejects.toThrow();
    });
  });

  describe('t.integer().unsigned()', () => {
    test('takes zero and positives', async () => {
      const [row] = await into(tasks).values(task({ attempts: 0, maxAttempts: 10 })).insert(db);

      expect(row).toMatchObject({ attempts: 0, maxAttempts: 10 });
    });

    test('rejects negatives', async () => {
      await expect(into(tasks).values(task({ attempts: -1 })).insert(db)).rejects.toThrow();
    });

    test('rejects fractions', async () => {
      await expect(into(tasks).values(task({ attempts: 1.5 })).insert(db)).rejects.toThrow();
    });
  });

  describe('t.timestamp()', () => {
    test('round-trips instants to the millisecond', async () => {
      const scheduledTo = Temporal.Instant.from('2026-11-14T12:34:56.789Z');
      const [row] = await into(tasks).values(task({ scheduledTo })).insert(db);

      expect(row!.scheduledTo).toEqual(scheduledTo);
      expect((await from(tasks).one(db))!.scheduledTo).toEqual(scheduledTo);
    });

    test('truncates instants to the millisecond', async () => {
      const scheduledTo = Temporal.Instant.from('2026-11-14T12:34:56.789999Z');
      const truncated = Temporal.Instant.from('2026-11-14T12:34:56.789Z');
      const [row] = await into(tasks).values(task({ scheduledTo, events: [{ kind: 'scheduled', timestamp: scheduledTo }] })).insert(db);

      expect(row).toMatchObject({ scheduledTo: truncated, events: [{ timestamp: truncated }] });
      expect(await from(tasks).where(tasks.scheduledTo, '=', truncated).count(db)).toBe(1);
    });

    test('takes ISO strings and epoch milliseconds', async () => {
      const [a, b] = await into(tasks).values([
        task({ scheduledTo: '2026-11-14T12:34:56.789+02:00' }),
        task({ scheduledTo: 0 }),
      ]).insert(db);

      expect(a!.scheduledTo).toEqual(Temporal.Instant.from('2026-11-14T10:34:56.789Z'));
      expect(b!.scheduledTo).toEqual(Temporal.Instant.fromEpochMilliseconds(0));
    });

    test('rejects ISO strings without an offset, and native dates', async () => {
      await expect(into(tasks).values(task({ scheduledTo: '2026-11-14T12:34:56' })).insert(db)).rejects.toThrow();
      await expect(into(tasks).values(task({ scheduledTo: new Date() as never })).insert(db)).rejects.toThrow();
    });

    test('compares instants, regardless of offset', async () => {
      await into(tasks).values(task({ scheduledTo: Temporal.Instant.from('2026-11-14T12:00:00Z') })).insert(db);

      expect(await from(tasks).where(tasks.scheduledTo, '=', Temporal.Instant.from('2026-11-14T09:00:00-03:00')).count(db)).toBe(1);
      expect(await from(tasks).where(tasks.scheduledTo, '<', Temporal.Instant.from('2026-11-14T12:00:00.001Z')).count(db)).toBe(1);
    });

    test('sends instants in UTC, to the millisecond', async () => {
      const scheduledTo = Temporal.Instant.from('2026-11-14T09:34:56.789999-03:00');
      // what each database is sent for 2026-11-14T12:34:56.789Z
      const utc = { 'bun-sqlite': 1794659696789, 'bun-postgres': '2026-11-14T12:34:56.789Z' }[adapter.name];

      await into(tasks).values(task({ scheduledTo })).insert(db);
      expect(params.at(-1)).toContain(utc);

      await from(tasks).update(db, { set: { scheduledTo } });
      expect(params.at(-1)).toContain(utc);

      expect(await from(tasks).where(tasks.scheduledTo, '=', scheduledTo).count(db)).toBe(1);
      expect(params.at(-1)).toContain(utc);

      expect(await from(tasks).where(f`${tasks.scheduledTo} = ${scheduledTo}`.as(t.boolean())).count(db)).toBe(1);
      expect(params.at(-1)).toContain(utc);
    });

    // with milliseconds always, so that they sort like the instants they are
    test('stores nested instants as ISO 8601 strings in UTC, with milliseconds', async () => {
      await into(tasks).values(task({
        events: [
          { kind: 'scheduled', timestamp: Temporal.Instant.from('2026-11-14T09:34:56.789-03:00') },
          { kind: 'queued', timestamp: Temporal.Instant.from('2026-11-14T12:34:57Z') },
        ],
      })).insert(db);

      const [row] = await db.execute('SELECT CAST("events" AS TEXT) AS "events" FROM "tasks"', []);

      expect(JSON.parse(row!['events'] as string)).toEqual([
        expect.objectContaining({ timestamp: '2026-11-14T12:34:56.789Z' }),
        expect.objectContaining({ timestamp: '2026-11-14T12:34:57.000Z' }),
      ]);
    });

    test('reads nested instants back', async () => {
      const timestamp = Temporal.Instant.from('2026-11-14T09:00:00-03:00');
      await into(tasks).values(task({ events: [{ kind: 'scheduled', timestamp }] })).insert(db);

      const row = await from(tasks).select({ events: tasks.events }).one(db);

      expect(row).toEqual({ events: [{ kind: 'scheduled', data: {}, timestamp }] });
    });
  });

  describe('t.record()', () => {
    test('round-trips objects', async () => {
      const params = { n: 1, list: ['a', 2], nested: { ok: true } };
      await into(tasks).values(task({ payload: { kind: 'Prune', params } })).insert(db);

      expect((await from(tasks).one(db))!.payload.params).toEqual(params);
    });
  });

  describe('.default()', () => {
    test('fills in a static default', async () => {
      const [row] = await into(tasks).values(task()).insert(db);

      expect(row).toMatchObject({ attempts: 0, maxAttempts: 3 });
    });

    test('fills in a function default, once per row', async () => {
      const before = Date.now();
      const [a, b] = await into(tasks).values([task(), task()]).insert(db);
      const after = Date.now();

      expect(a!.createdAt).toBeInstanceOf(Temporal.Instant);
      expect(a!.createdAt.epochMilliseconds).toBeGreaterThanOrEqual(before);
      expect(a!.createdAt.epochMilliseconds).toBeLessThanOrEqual(after);
      expect(a!.createdAt).not.toBe(b!.createdAt);
    });

    test('is overridden by a given value', async () => {
      const scheduledTo = minutesAgo(5);
      const [row] = await into(tasks).values(task({ attempts: 2, scheduledTo })).insert(db);

      expect(row).toMatchObject({ attempts: 2, scheduledTo });
    });
  });

  describe('.nullable()', () => {
    test('defaults to null', async () => {
      const [t] = await into(tasks).values(task()).insert(db);
      const [u] = await into(users).values(jane).insert(db);

      expect(t!.parentId).toBeNull();
      expect(u!.lastLoggedInAt).toBeNull();
    });

    test('takes a value', async () => {
      const [parent] = await into(tasks).values(task()).insert(db);
      const [child] = await into(tasks).values(task({ parentId: parent!.id })).insert(db);

      expect(child!.parentId).toBe(parent!.id);
    });
  });

  describe('embedded.one()', () => {
    test('round-trips an object, filling in its defaults', async () => {
      await into(tasks).values(task({ payload: { kind: 'Prune' } })).insert(db);

      expect((await from(tasks).one(db))!.payload).toEqual({ kind: 'Prune', params: {} });
    });

    test('validates its fields', async () => {
      const row = JSON.parse('{"status":"queued","payload":{"kind":1},"events":[]}');

      await expect(into(tasks).values(row).insert(db)).rejects.toThrow();
    });
  });

  describe('embedded.many()', () => {
    test('round-trips a list of objects, filling in their defaults', async () => {
      const timestamp = Temporal.Instant.from('2026-11-14T00:00:00.000Z');
      await into(tasks).values(task({ events: [{ kind: 'scheduled' }, { kind: 'queued', data: { by: 'cron' }, timestamp }] })).insert(db);

      const [scheduled, queued] = (await from(tasks).one(db))!.events;

      expect(scheduled).toMatchObject({ kind: 'scheduled', data: {} });
      expect(scheduled!.timestamp).toBeInstanceOf(Temporal.Instant);
      expect(queued).toEqual({ kind: 'queued', data: { by: 'cron' }, timestamp });
    });

    test('round-trips an empty list', async () => {
      await into(tasks).values(task({ events: [] })).insert(db);

      expect((await from(tasks).one(db))!.events).toEqual([]);
    });

    test('validates every item', async () => {
      const row = JSON.parse('{"status":"queued","payload":{"kind":"Prune"},"events":[{"kind":"scheduled"},{"kind":"nope"}]}');

      await expect(into(tasks).values(row).insert(db)).rejects.toThrow();
    });
  });

  describe('defineType()', () => {
    test('stores values as its primitive', async () => {
      const [row] = await into(users).values(jane).insert(db);

      expect(row!.email).toBe('jane.doe@example.com');
    });

    test('validates values with its schema', async () => {
      await expect(into(users).values({ ...jane, email: 'not an email' }).insert(db)).rejects.toThrow();
    });
  });
});
