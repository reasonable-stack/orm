import { beforeEach, expect, test } from 'bun:test';
import * as r from '@reasonable-stack/datetime';
import { exp, from, into } from '../src';
import { type User, jane, minutesAgo, task, tasks, users } from './fixtures';
import { type Database, type Equals, assert, suite } from './helpers';

suite('coalesce', (fresh) => {
  let db: Database;
  let janeRow: User;
  let johnRow: User;

  const epoch = r.DateTime.parse(0);

  beforeEach(async () => {
    ({ db } = await fresh());

    [janeRow, johnRow] = (await into(users).values([
      jane,
      { name: 'John Doe', email: 'john.doe@example.com', lastLoggedInAt: minutesAgo(1) },
    ]).insert(db)) as [User, User];
  });

  test('reads the first operand that is not null', async () => {
    const rows = await from(users)
      .orderBy([users.name])
      .select({ name: users.name, seen: exp.coalesce(users.lastLoggedInAt, users.createdAt) })
      .all(db);

    expect(rows).toEqual([
      { name: 'Jane Doe', seen: janeRow.createdAt },
      { name: 'John Doe', seen: johnRow.lastLoggedInAt! },
    ]);
  });

  test('falls back to a plain value', async () => {
    const rows = await from(users)
      .orderBy([users.name])
      .select({ seen: exp.coalesce(users.lastLoggedInAt, epoch) })
      .all(db);

    expect(rows).toEqual([{ seen: epoch }, { seen: johnRow.lastLoggedInAt! }]);
  });

  test('compares like its first operand', async () => {
    const rows = await from(users).where(exp.coalesce(users.lastLoggedInAt, epoch), '=', epoch).select({ id: users.id }).all(db);

    expect(rows).toEqual([{ id: janeRow.id }]);
  });

  test('fills in for the columns of unmatched rows', async () => {
    const parent = tasks.as('parent');
    const child = tasks.as('child');

    await into(tasks).values(task({ payload: { kind: 'lonely' } })).insert(db);

    const rows = await from(parent)
      .leftJoin(child, exp(parent.id, '=', child.parentId))
      .select({ kind: exp.coalesce(child.payload.kind, 'none'), attempts: exp.coalesce(child.attempts, -1) })
      .all(db);

    expect(rows).toEqual([{ kind: 'none', attempts: -1 }]);
  });
});

// ─── type-level ──────────────────────────────────────────────────────────────

export const typeChecks = async (db: Database) => {
  const parent = tasks.as('parent');
  const child = tasks.as('child');

  // null only when every operand may be
  const c1 = await from(users)
    .select({
      columns: exp.coalesce(users.lastLoggedInAt, users.createdAt),
      value: exp.coalesce(users.lastLoggedInAt, r.DateTime.parse(0)),
      nullable: exp.coalesce(users.lastLoggedInAt, users.lastLoggedInAt),
    })
    .all(db);
  assert<Equals<typeof c1, { columns: r.DateTime; value: r.DateTime; nullable: r.DateTime | null }[]>>();

  // a left-joined column may read null, unless a value or a column of the
  // queried table stands in for it
  const c2 = await from(parent)
    .leftJoin(child, exp(parent.id, '=', child.parentId))
    .select({
      value: exp.coalesce(child.payload.kind, 'none'),
      column: exp.coalesce(child.id, parent.id),
      joined: exp.coalesce(child.id, child.parentId),
    })
    .all(db);
  assert<Equals<typeof c2, { value: string; column: string; joined: string | null }[]>>();

  // ...or the join keeps its rows
  const c3 = await from(parent)
    .innerJoin(child, exp(parent.id, '=', child.parentId))
    .select({ joined: exp.coalesce(child.id, child.parentId) })
    .all(db);
  assert<Equals<typeof c3, { joined: string }[]>>();

  // it reads null only when the rows of every table it reads from may be missing
  const other = tasks.as('other');
  const c4 = await from(parent)
    .leftJoin(child, exp(parent.id, '=', child.parentId))
    .leftJoin(other, exp(other.id, '=', parent.parentId))
    .select({ id: exp.coalesce(child.id, other.id) })
    .all(db);
  assert<Equals<typeof c4, { id: string | null }[]>>();

  const c5 = await from(parent)
    .leftJoin(child, exp(parent.id, '=', child.parentId))
    .innerJoin(other, exp(other.id, '=', parent.parentId))
    .select({ id: exp.coalesce(child.id, other.id) })
    .all(db);
  assert<Equals<typeof c5, { id: string }[]>>();

  // @ts-expect-error every operand has to read the same type
  exp.coalesce(users.lastLoggedInAt, 'never');

  // @ts-expect-error every operand has to read the same type
  exp.coalesce(users.lastLoggedInAt, users.name);

  // @ts-expect-error coalesce takes references to the query's tables only
  from(users).select({ id: exp.coalesce(tasks.parentId, tasks.id) });
};
