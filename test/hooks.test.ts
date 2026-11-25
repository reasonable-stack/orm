import { beforeEach, expect, test } from 'bun:test';
import { type Infer, ValidationError, embedded, from, into, parse, t, table } from '../src';
import { create } from '../src/experimental-migrations';
import { type Database, type Equals, type OptionalKeys, assert, suite } from './helpers';

// a clock the tests move by hand, so that every hook's value is known
let clock = Temporal.Instant.from('2026-01-01T00:00:00Z');
const tick = (minutes = 1) => (clock = clock.add({ minutes }));
const at = () => clock;

const accounts = table('accounts', {
  id: t.uuidv7().generated().primaryKey(),
  email: t.string().unique(),
  logins: t.integer().default(0),
  revision: t.integer().on('create', () => 1).on('update', () => 0),
  createdAt: t.timestamp().on('create', at),
  updatedAt: t.timestamp().on('create', at).on('update', at),
});

type Account = Infer<typeof accounts>;

const ada = { email: 'ada@example.com' };

const issuesOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(ValidationError);
  return (error as ValidationError).issues.map(({ path, message }) => ({ path, message }));
};

suite('hooks', (fresh) => {
  let db: Database;
  let start: Temporal.Instant;

  beforeEach(async () => {
    ({ db } = await fresh());
    await create.table(accounts).run(db);
    start = tick();
  });

  test('set columns on insert', async () => {
    const [row] = await into(accounts).values(ada).insert(db);

    expect(row).toMatchObject({ revision: 1, createdAt: start, updatedAt: start });
    expect(await from(accounts).all(db)).toEqual([row!]);
  });

  test('are called for every row of an insert', async () => {
    let calls = 0;
    const counted = table('counted', {
      id: t.uuidv7().generated().primaryKey(),
      n: t.integer().on('create', () => ++calls),
    });
    await create.table(counted).run(db);

    const rows = await into(counted).values([{}, {}, {}]).insert(db);

    expect(rows.map(row => row.n).sort()).toEqual([1, 2, 3]);
  });

  test('set columns on update, leaving those hooked on insert only', async () => {
    const [created] = (await into(accounts).values(ada).insert(db)) as [Account];
    const later = tick();

    const [updated] = await from(accounts).update(db, { set: { email: 'ada@lovelace.dev' } });

    expect(updated).toEqual({ ...created, email: 'ada@lovelace.dev', revision: 0, updatedAt: later });
    expect(updated!.createdAt).toEqual(start);
  });

  test('set columns on an update that only increments', async () => {
    await into(accounts).values(ada).insert(db);
    const later = tick();

    const [updated] = await from(accounts).update(db, { inc: { logins: 1 } });

    expect(updated).toMatchObject({ logins: 1, updatedAt: later });
  });

  test('set columns on an upsert\'s update', async () => {
    const [created] = (await into(accounts).values(ada).insert(db)) as [Account];
    const later = tick();

    const [upserted] = await into(accounts)
      .values(ada)
      .insert(db, { conflict: { on: ['email'], do: { inc: { logins: 1 } } } });

    expect(upserted).toEqual({ ...created, logins: 1, revision: 0, updatedAt: later });
  });

  test('leave a row an upsert does nothing to as it is', async () => {
    const [created] = (await into(accounts).values(ada).insert(db)) as [Account];
    tick();

    await into(accounts).values(ada).insert(db, { conflict: { on: ['email'], do: 'nothing' } });

    expect(await from(accounts).all(db)).toEqual([created]);
  });

  test('always win: columns they set take no values of their own', async () => {
    const insert = into(accounts).values({ ...ada, createdAt: start } as never).insert(db);
    expect(await issuesOf(insert)).toEqual([{ path: ['createdAt'], message: 'unknown field' }]);

    await into(accounts).values(ada).insert(db);

    const update = from(accounts).update(db, { set: { updatedAt: start } as never });
    expect(await issuesOf(update)).toEqual([{ path: ['updatedAt'], message: 'unknown field' }]);

    await expect(from(accounts).update(db, { inc: { revision: 1 } as never })).rejects.toThrow('"revision" isn\'t an updatable column of "accounts"');

    const upsert = into(accounts).values(ada).insert(db, { conflict: { on: ['email'], do: { replace: ['updatedAt'] as never } } });
    await expect(upsert).rejects.toThrow('"updatedAt" isn\'t an updatable column of "accounts"');
  });

  test('don\'t count as something to update', async () => {
    await into(accounts).values(ada).insert(db);

    await expect(from(accounts).update(db, { set: {} })).rejects.toThrow('Nothing to update: both `set` and `inc` are empty');

    const upsert = into(accounts).values(ada).insert(db, { conflict: { on: ['email'], do: { set: {} } } });
    await expect(upsert).rejects.toThrow('Nothing to update on conflict');
  });

  test('are left to the insert by parse, which takes no values for their columns', async () => {
    expect(parse(accounts, ada)).toEqual({ email: ada.email, logins: 0 });
    expect(() => parse(accounts, { ...ada, createdAt: start })).toThrow(ValidationError);
  });

  test('give values that are validated like any other', async () => {
    const invalid = table('invalid', {
      id: t.uuidv7().generated().primaryKey(),
      at: t.timestamp().on('create', () => 'yesterday' as never),
    });
    await create.table(invalid).run(db);

    expect((await issuesOf(into(invalid).values({}).insert(db)))[0]!.path).toEqual(['at']);
  });
});

suite('t.timestamps()', (fresh) => {
  let db: Database;

  beforeEach(async () => {
    ({ db } = await fresh());
  });

  test('sets createdAt on insert, and updatedAt on insert and update', async () => {
    const posts = table('posts', { id: t.uuidv7().generated().primaryKey(), title: t.string(), ...t.timestamps() });
    await create.table(posts).run(db);

    const before = Temporal.Now.instant().round({ smallestUnit: 'millisecond', roundingMode: 'floor' });
    const [created] = await into(posts).values({ title: 'Hello' }).insert(db);
    await Bun.sleep(2);
    const [updated] = await from(posts).update(db, { set: { title: 'Hello, world' } });

    expect(Temporal.Instant.compare(created!.createdAt, before)).toBeGreaterThanOrEqual(0);
    expect(updated!.createdAt).toEqual(created!.createdAt);
    expect(Temporal.Instant.compare(updated!.updatedAt, created!.updatedAt)).toBe(1);
  });

  test('takes other keys', async () => {
    const posts = table('posts', {
      id: t.uuidv7().generated().primaryKey(),
      ...t.timestamps({ createdAt: 'insertedAt', updatedAt: 'lastChangedAt' }),
    });
    await create.table(posts).run(db);

    const [row] = await into(posts).values({}).insert(db);

    expect(Object.keys(row!).sort()).toEqual(['id', 'insertedAt', 'lastChangedAt']);
    expect(Object.keys(posts).sort()).toEqual(['id', 'insertedAt', 'lastChangedAt']);
  });

  test('takes two different keys', () => {
    expect(() => t.timestamps({ createdAt: 'at', updatedAt: 'at' })).toThrow('Timestamps take two keys, got "at" for both');
  });
});

test('a column takes one hook per event, and only on "create" and "update"', () => {
  const now = () => Temporal.Now.instant();

  expect(() => t.timestamp().on('create', now).on('create', now)).toThrow('The column already has a hook on "create"');
  expect(() => t.timestamp().on('delete' as never, now)).toThrow('Unknown event "delete"');
});

test('embedded fields take no hooks', () => {
  expect(() => embedded.one({ at: t.timestamp().on('create', () => Temporal.Now.instant()) })).toThrow('"at" is an embedded field, which takes no hooks');
});

test('columns set by a hook are left out of what its event takes', () => {
  // type-level only, never called
  const typecheck = () => {
    type Insert = Infer<typeof accounts, 'insert'>;
    type Update = Infer<typeof accounts, 'update'>;

    assert<Equals<keyof Insert, 'email' | 'logins'>>();
    assert<Equals<OptionalKeys<Insert>, 'logins'>>();
    assert<Equals<keyof Update, 'email' | 'logins' | 'createdAt'>>();
    assert<Equals<Infer<typeof accounts>['updatedAt'], Temporal.Instant>>();

    const stamps = t.timestamps({ createdAt: 'insertedAt', updatedAt: 'lastChangedAt' });
    assert<Equals<keyof typeof stamps, 'insertedAt' | 'lastChangedAt'>>();

    // @ts-expect-error a hook gives the column's own values
    t.timestamp().on('create', () => 'now');

    // @ts-expect-error set by its hook on insert
    into(accounts).values({ ...ada, createdAt: Temporal.Now.instant() });

    // @ts-expect-error set by its hook on update
    from(accounts).update(undefined as unknown as Database, { set: { updatedAt: Temporal.Now.instant() } });
  };

  expect(typecheck).toBeFunction();
});
