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
  revision: t.integer().on('insert', () => 1).on('update', () => 0),
  createdAt: t.timestamp().on('insert', at),
  updatedAt: t.timestamp().on('insert', at).on('update', at),
});

type Account = Infer<typeof accounts>;

const ada = { email: 'ada@example.com' };

const past = Temporal.Instant.from('2020-01-01T00:00:00Z');

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
      n: t.integer().on('insert', () => ++calls),
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

  test('give way to values given on insert', async () => {
    const [row] = await into(accounts).values({ ...ada, createdAt: past, revision: 7 }).insert(db);

    expect(row).toMatchObject({ revision: 7, createdAt: past, updatedAt: start });
  });

  test('are called for columns given undefined', async () => {
    const [row] = await into(accounts).values({ ...ada, createdAt: undefined }).insert(db);

    expect(row!.createdAt).toEqual(start);
  });

  test('give way to values set or incremented on update', async () => {
    await into(accounts).values(ada).insert(db);
    const later = tick();

    const [set] = await from(accounts).update(db, { set: { updatedAt: past } });
    expect(set).toMatchObject({ revision: 0, updatedAt: past });

    const [inc] = await from(accounts).update(db, { inc: { revision: 5 } });
    expect(inc).toMatchObject({ revision: 5, updatedAt: later });
  });

  test('give way to values set on an upsert\'s update', async () => {
    await into(accounts).values(ada).insert(db);
    tick();

    const [upserted] = await into(accounts)
      .values(ada)
      .insert(db, { conflict: { on: ['email'], do: { set: { updatedAt: past } } } });

    expect(upserted).toMatchObject({ revision: 0, updatedAt: past });
  });

  test('don\'t count as something to update', async () => {
    await into(accounts).values(ada).insert(db);

    await expect(from(accounts).update(db, { set: {} })).rejects.toThrow('Nothing to update: both `set` and `inc` are empty');

    const upsert = into(accounts).values(ada).insert(db, { conflict: { on: ['email'], do: { set: {} } } });
    await expect(upsert).rejects.toThrow('Nothing to update on conflict');
  });

  test('are left to the insert by parse, which still takes values of their own', async () => {
    expect(parse(accounts, ada)).toEqual({ email: ada.email, logins: 0 });
    expect(parse(accounts, { ...ada, createdAt: undefined })).toEqual({ email: ada.email, logins: 0 });
    expect(parse(accounts, { ...ada, createdAt: past.toString() })).toEqual({ email: ada.email, logins: 0, createdAt: past });

    const [row] = await into(accounts).values(parse(accounts, ada)).insert(db);
    expect(row!.createdAt).toEqual(start);
  });

  test('give values that are validated like any other', async () => {
    const invalid = table('invalid', {
      id: t.uuidv7().generated().primaryKey(),
      at: t.timestamp().on('insert', () => 'yesterday' as never),
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

test('a column takes one hook per event, and only on "insert" and "update"', () => {
  const now = () => Temporal.Now.instant();

  expect(() => t.timestamp().on('insert', now).on('insert', now)).toThrow('The column already has a hook on "insert"');
  expect(() => t.timestamp().on('delete' as never, now)).toThrow('Unknown event "delete"');
});

test('embedded fields take no hooks', () => {
  expect(() => embedded.one({ at: t.timestamp().on('insert', () => Temporal.Now.instant()) })).toThrow('"at" is an embedded field, which takes no hooks');
});

test('columns set by a hook are optional in what its event takes', () => {
  // type-level only, never called
  const typecheck = () => {
    type Insert = Infer<typeof accounts, 'insert'>;
    type Update = Infer<typeof accounts, 'update'>;

    assert<Equals<keyof Insert, 'email' | 'logins' | 'revision' | 'createdAt' | 'updatedAt'>>();
    assert<Equals<OptionalKeys<Insert>, 'logins' | 'revision' | 'createdAt' | 'updatedAt'>>();
    assert<Equals<keyof Update, 'email' | 'logins' | 'revision' | 'createdAt' | 'updatedAt'>>();
    assert<Equals<OptionalKeys<Update>, keyof Update>>();
    assert<Equals<Infer<typeof accounts>['updatedAt'], Temporal.Instant>>();

    const stamps = t.timestamps({ createdAt: 'insertedAt', updatedAt: 'lastChangedAt' });
    assert<Equals<keyof typeof stamps, 'insertedAt' | 'lastChangedAt'>>();

    // spread inline, where the keys are inferred in the table's context
    const posts = table('posts', { id: t.uuidv7().generated().primaryKey(), title: t.string(), ...t.timestamps() });
    const comments = table('comments', {
      id: t.uuidv7().generated().primaryKey(),
      body: t.text(),
      ...t.timestamps({ createdAt: 'insertedAt', updatedAt: 'lastChangedAt' }),
    });

    type PostInsert = Infer<typeof posts, 'insert'>;
    type CommentInsert = Infer<typeof comments, 'insert'>;

    assert<Equals<keyof PostInsert, 'title' | 'createdAt' | 'updatedAt'>>();
    assert<Equals<OptionalKeys<PostInsert>, 'createdAt' | 'updatedAt'>>();
    assert<Equals<keyof CommentInsert, 'body' | 'insertedAt' | 'lastChangedAt'>>();
    assert<Equals<OptionalKeys<CommentInsert>, 'insertedAt' | 'lastChangedAt'>>();
    assert<Equals<keyof Infer<typeof comments>, 'id' | 'body' | 'insertedAt' | 'lastChangedAt'>>();

    into(posts).values({ title: 'Hello' });
    into(comments).values({ body: 'Hi', lastChangedAt: Temporal.Now.instant() });

    type PostUpdate = Infer<typeof posts, 'update'>;
    type CommentUpdate = Infer<typeof comments, 'update'>;

    assert<Equals<keyof PostUpdate, 'title' | 'createdAt' | 'updatedAt'>>();
    assert<Equals<OptionalKeys<PostUpdate>, keyof PostUpdate>>();
    assert<Equals<keyof CommentUpdate, 'body' | 'insertedAt' | 'lastChangedAt'>>();
    assert<Equals<OptionalKeys<CommentUpdate>, keyof CommentUpdate>>();

    const db = undefined as unknown as Database;
    from(posts).update(db, { set: { title: 'Hello, world' } });
    from(comments).update(db, { set: { lastChangedAt: Temporal.Now.instant() } });

    // @ts-expect-error a hook gives the column's own values
    t.timestamp().on('insert', () => 'now');
  };

  expect(typecheck).toBeFunction();
});
