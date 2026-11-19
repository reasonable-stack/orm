# @reasonable-stack/orm

A reasonably good ORM for SQL databases on TypeScript.

It's a type-safe query builder for [Bun](https://bun.sh), with adapters for
SQLite and PostgreSQL.

```ts
import * as r from '@reasonable-stack/datetime';
import { from, into, table, t } from '@reasonable-stack/orm';
import * as sqlite from '@reasonable-stack/orm/bun-sqlite';
import { create } from '@reasonable-stack/orm/experimental-migrations';

const users = table('users', {
  id: t.uuidv7().generated().primaryKey(),
  name: t.string(),
  email: t.citext().unique(),
  createdAt: t.timestamp().default(() => r.nowUTC()),
});

const db = sqlite.connect('./db.sqlite');
await create.table(users, { ifNotExists: true }).run(db);

await into(users)
  .values({ name: 'Jane Doe', email: 'jane@example.com' })
  .insert(db);

const jane = await from(users)
  .where(users.email, '=', 'JANE@example.com')
  .select({ id: users.id, name: users.name })
  .one(db);
// → { id: string, name: string } | null
```

- Columns, operators and values are type-checked and autocompleted.
- Values are validated before any SQL runs.
- No singletons: you always pass the database explicitly.


## Contents

- [Install](#install)
- [Connecting](#connecting)
- [Tables](#tables)
  - [Custom types](#custom-types)
- [Migrations](#migrations)
- [Insert](#insert)
  - [On conflict](#on-conflict)
- [Select](#select)
  - [Regular expressions](#regular-expressions)
  - [Picking columns](#picking-columns)
  - [Comparing columns](#comparing-columns)
  - [Coalesce](#coalesce)
  - [AND, OR and NOT](#and-or-and-not)
  - [Embedded fields](#embedded-fields)
  - [Raw SQL fragments](#raw-sql-fragments)
- [Group by](#group-by)
- [Joins](#joins)
- [Update](#update)
- [Delete](#delete)
- [Transactions](#transactions)
- [Validation](#validation)
- [License](#license)


## Install

```sh
bun add @reasonable-stack/orm @reasonable-stack/datetime
```

Requires Bun 1.4.4 or later, and TypeScript 5.4 or later.
[`@reasonable-stack/datetime`](https://github.com/reasonable-stack/datetime)
(0.2.0 or later) is a peer dependency: timestamps and dates are read as its
`r.DateTime` and `r.Date`.


## Connecting

```ts
import * as sqlite from '@reasonable-stack/orm/bun-sqlite';
import * as pg from '@reasonable-stack/orm/bun-postgres';

const db = sqlite.connect(':memory:');
const db = pg.connect('postgres://user:pass@localhost:5432/app');

// log every statement
const db = sqlite.connect(':memory:', { loggers: [console] });

await db.close();
```

A logger is anything with `debug(sql, params)` and `error(sql, params, error)`
methods.


## Tables

```ts
import * as r from '@reasonable-stack/datetime';
import { embedded, table, t, type Infer } from '@reasonable-stack/orm';

const tasks = table('tasks', {
  id: t.uuidv7().generated().primaryKey(),
  parentId: t.uuidv7().nullable(),
  status: t.enum(['scheduled', 'running', 'succeeded', 'failed']),
  attempts: t.integer().unsigned().default(0),
  maxAttempts: t.integer().unsigned().default(3),
  payload: embedded.one({
    kind: t.string(),
    params: t.record().default({}),
  }),
  events: embedded.many({
    kind: t.string(),
    timestamp: t.timestamp().default(() => r.nowUTC()),
  }),
  scheduledTo: t.timestamp().default(() => r.nowUTC()),
});

const users = table('users', {
  id: t.uuidv7().generated().primaryKey(),
  name: t.string(),
  email: t.citext().unique(),
  logins: t.integer().unsigned().default(0),
  createdAt: t.timestamp().default(() => r.nowUTC()),
  lastLoggedInAt: t.timestamp().nullable(),
});

type Task = Infer<typeof tasks>;                 // a row
type TaskInsert = Infer<typeof tasks, 'insert'>; // what `.values()` takes
type TaskUpdate = Infer<typeof tasks, 'update'>; // what `set` takes
```

Keys are camelCase in TypeScript and snake_case in the database
(`scheduledTo` → `scheduled_to`).

| builder                            | TS type                   | postgres           | sqlite                  |
| :--------------------------------- | :------------------------ | :----------------- | :---------------------- |
| `t.bigint()`                       | `bigint`                  | `BIGINT`           | `INTEGER`               |
| `t.binary()`                       | `Uint8Array`              | `BYTEA`            | `BLOB`                  |
| `t.boolean()`                      | `boolean`                 | `BOOLEAN`          | `INTEGER`               |
| `t.citext()`                       | `string`                  | `CITEXT`           | `TEXT COLLATE NOCASE`   |
| `t.date()`                         | `r.Date`                  | `DATE`             | `TEXT`                  |
| `t.decimal({ precision, scale }?)` | `number`                  | `NUMERIC(p, s)`    | `NUMERIC`               |
| `t.enum([...values])`              | union of values           | `VARCHAR(n)`       | `TEXT`                  |
| `t.float()`                        | `number`                  | `DOUBLE PRECISION` | `REAL`                  |
| `t.integer()`                      | `number`                  | `BIGINT`           | `INTEGER`               |
| `t.json(schema)`                   | schema's output           | `JSONB`            | `TEXT`                  |
| `t.record()`                       | `Record<string, unknown>` | `JSONB`            | `TEXT`                  |
| `t.sequence()`                     | `number`                  | `BIGINT` identity  | `INTEGER` autoincrement |
| `t.string({ size? })`              | `string`                  | `VARCHAR(size)`    | `TEXT`                  |
| `t.text()`                         | `string`                  | `TEXT`             | `TEXT`                  |
| `t.timestamp()`                    | `r.DateTime`              | `TIMESTAMPTZ`      | `INTEGER`               |
| `t.uuidv7()`                       | `string`                  | `UUID`             | `TEXT`                  |
| `embedded.one({ ... })`            | an object                 | `JSONB`            | `TEXT`                  |
| `embedded.many({ ... })`           | an array of objects       | `JSONB`            | `TEXT`                  |

| modifier        | effect                                        |
| :-------------- | :-------------------------------------------- |
| `.primaryKey()` | primary key                                   |
| `.nullable()`   | accepts `null`, optional on insert            |
| `.default(v)`   | value or function used when omitted on insert |
| `.unique()`     | unique constraint                             |
| `.generated()`  | a UUIDv7 generated on insert (`t.uuidv7()`)   |
| `.unsigned()`   | rejects negatives (`t.integer()`)             |

`t.timestamp()` values are `r.DateTime`s from
[`@reasonable-stack/datetime`](https://github.com/reasonable-stack/datetime),
always stored and read back in UTC, whatever offset they were written with
(including those interpolated into a fragment, or nested in an embedded
document), so the database's time zone never matters. They also
take ISO 8601 strings with an offset (`'2026-11-14T09:00:00-03:00'`) and epoch
milliseconds, but not native `Date`s. `t.date()` values are `r.Date`s, and
also take `YYYY-MM-DD` strings.

`t.string()` holds up to 255 characters unless given a `size`, and
`t.enum()`'s `n` is the length of its longest value. `t.sequence()` can only
be the primary key on sqlite. `t.json()` takes any
[Standard Schema](https://standardschema.dev) (zod, valibot, arktype, ...).
`t.citext()` needs `CREATE EXTENSION citext` on postgres (see
[migrations](#migrations)).

### Custom types

```ts
import { defineType } from '@reasonable-stack/orm';
import { z } from 'zod';

const email = () => defineType({ primitive: 'STRING', schema: z.email() });

const contacts = table('contacts', {
  id: t.uuidv7().generated().primaryKey(),
  email: email(),
});
```


## Migrations

> [!WARNING]
> Migrations are experimental, hence their entry point's name: their API may
> change in any release.

```ts
import { create, exec, migrations } from '@reasonable-stack/orm/experimental-migrations';

const migrate = migrations({
  '0001': async (db) => {
    if (db.dialect.name === 'postgres') await exec('CREATE EXTENSION IF NOT EXISTS citext').run(db);
    await create.table(users).run(db);
  },
  '0002': async (db) => {
    await create.table(tasks).run(db);
    await create.index('tasks_status_scheduled_to_idx', {
      table: 'tasks',
      columns: ['status', ['scheduled_to', 'DESC']],
    }).run(db);
  },
});

await migrate(db);
```

Migrations run in the order of their keys, each in its own transaction, and
only once: applied ones are tracked in the `schema_migrations` table. A
failing migration is rolled back, and the ones after it don't run.

`create.table()` creates a table the way its definition says it is today. Any
other change takes the name of a table or column the way the database spells
it (snake_case), verbatim: a migration describes the schema as it was when it
ran, which today's definitions may no longer match.

```ts
import { t } from '@reasonable-stack/orm';
import { all, alter, create, drop, exec, file, migrations } from '@reasonable-stack/orm/experimental-migrations';

const migrate = migrations({
  // ...
  '0003': async (db) => {
    await alter.table('tasks')
      .addColumn('created_by', t.uuidv7().nullable())
      .addColumn('priority', t.integer().default(0), { backfill: 0 })
      .renameColumn('scheduled_to', 'run_at')
      .dropColumn('events')
      .run(db);
  },
  '0004': async (db) => {
    await alter.table('tasks').rename('jobs').run(db);
    await create.index('jobs_status_run_at_idx', {
      table: 'jobs',
      columns: ['status', 'run_at'],
      where: `"status" = 'scheduled'`,
      ifNotExists: true,
    }).run(db);
  },
  '0005': all([
    drop.index('tasks_status_scheduled_to_idx', { ifExists: true }),
    drop.table('legacy_jobs', { ifExists: true }),
  ]),
  '0006': all([
    file('migrations/0006.sql'),
    exec('UPDATE "users" SET "logins" = 0 WHERE "logins" IS NULL'),
  ]),
});
```

| runnable                                      | what it does                                        |
| :-------------------------------------------- | :-------------------------------------------------- |
| `create.table(table, { ifNotExists? })`       | creates a table from its definition                 |
| `create.index(name, { table, columns, ... })` | creates an index, see below                         |
| `alter.table(name)`                           | changes a table, see below                          |
| `drop.index(name, { ifExists? })`             | drops an index                                      |
| `drop.table(name, { ifExists? })`             | drops a table                                       |
| `exec(sql, params?)`                          | runs a single statement, and throws when given more |
| `file(path)`                                  | runs every statement of a SQL file, one at a time   |

Each of them runs with `.run(db)`. `all([...])` runs runnables and migration
functions one after the other, as a migration of its own.

`create.index()` takes the indexed `columns` as names, or `[name, 'DESC']`
pairs. `unique` makes it a unique index, `where` (raw SQL) a partial one, and
`ifNotExists` skips it when it's already there.

`alter.table()` applies its changes one after the other, in order. After
`.rename()`, the changes that follow apply to the table under its new name.
`.addColumn()` can't add a primary key, generated or unique column (add a
unique index instead). Defaults are filled in on insert, never by the
database, so the rows already in the table get `backfill`: it's required for a
column that isn't nullable, and nullable ones are null unless given one.

A failing statement of a `file` rolls back the whole migration. A relative
path is resolved from the working directory. To resolve it from the
migration's own module instead, pass a URL:
`new URL('./0006.sql', import.meta.url)`. `exec` also takes parameters, in
your database's placeholder syntax (`?` on sqlite, `$1` on postgres).


## Insert

```ts
import { into, parse } from '@reasonable-stack/orm';

const task: TaskInsert = { status: 'scheduled', payload: { kind: 'Prune' }, events: [] };

const inserted: Task[] = await into(tasks)
  .values(task)
  .values([task, task])
  .insert(db);

await into(tasks).values(task).insert(db, { returning: ['id', tasks.status] }); // → Pick<Task, 'id' | 'status'>[]
await into(tasks).values(task).insert(db, { returning: false });                // → undefined

// validate untrusted input, filling in defaults
const row: TaskInsert = parse(tasks, JSON.parse(body));
```

`insert`, `update` and `delete` all take `returning`. It defaults to `true`,
except for `delete`, which defaults to `false`:

| `returning`            | result      |
| :--------------------- | :---------- |
| `true`                 | full rows   |
| `[...keys or columns]` | only those  |
| `false`                | `undefined` |

### On conflict

```ts
const rows = [{ email: 'jane@example.com', name: 'Jane' }];

// skip rows that conflict
await into(users).values(rows).insert(db, {
  conflict: { on: ['email'], do: 'nothing' },
});

// update the existing row
await into(users).values(rows).insert(db, {
  conflict: {
    on: ['email'],
    do: {
      set: { lastLoggedInAt: r.nowUTC() }, // a given value
      inc: { logins: 1 },                  // an increment
      replace: ['name'],                   // the value being inserted
    },
  },
});

// throw, same as no `conflict` at all
await into(users).values(rows).insert(db, {
  conflict: { on: ['email'], do: 'throw' },
});
```


## Select

A table is shaped like its columns: `tasks.status` references a column.

```ts
import * as r from '@reasonable-stack/datetime';
import { exp, from } from '@reasonable-stack/orm';

const due: Task[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .where(tasks.scheduledTo, '<', r.nowUTC()) // multiple `where`s are ANDed
  .orderBy([tasks.scheduledTo, exp.desc(tasks.attempts)])
  .limit(10)
  .offset(20)
  .all(db);

const scheduled = from(tasks).where(tasks.status, '=', 'scheduled');

await scheduled.one(db);    // → Task | null, the first row
await scheduled.exists(db); // → boolean
await scheduled.count(db);  // → number
```

`orderBy` orders by an operand ascending, unless it's given in a direction:

| direction                    | SQL                |
| :--------------------------- | :----------------- |
| `exp.asc(operand)`           | `ASC`              |
| `exp.ascNullFirst(operand)`  | `ASC NULLS FIRST`  |
| `exp.ascNullLast(operand)`   | `ASC NULLS LAST`   |
| `exp.desc(operand)`          | `DESC`             |
| `exp.descNullFirst(operand)` | `DESC NULLS FIRST` |
| `exp.descNullLast(operand)`  | `DESC NULLS LAST`  |

Where nulls go otherwise differs between databases: last when ascending on
postgres, first on sqlite. Say where to put them, to read the same rows on
both:

```ts
await from(users).orderBy([exp.descNullLast(users.lastLoggedInAt)]).all(db);
```

| operator                                      | value                                                   |
| :-------------------------------------------- | :------------------------------------------------------ |
| `'='` `'!='` `'<'` `'<='` `'>'` `'>='`        | the column's type, or another column                    |
| `'IS DISTINCT FROM'` `'IS NOT DISTINCT FROM'` | like `'!='` and `'='`, but `null` is a value too        |
| `'IN'` `'NOT IN'`                             | a list of the column's type                             |
| `'BETWEEN'` `'NOT BETWEEN'`                   | a `[low, high]` pair, both included                     |
| `'LIKE'` `'NOT LIKE'`                         | a `string` pattern (text columns)                       |
| `'ILIKE'` `'NOT ILIKE'`                       | a case-insensitive `string` pattern (text columns)      |
| `'IS'` `'IS NOT'`                             | `null` (nullable columns), `true` or `false` (booleans) |

```ts
const lastWeek = r.nowUTC().sub(r.days(7));

await from(tasks).where(tasks.status, 'IN', ['scheduled', 'running']).all(db);
await from(tasks).where(tasks.status, 'NOT IN', ['succeeded']).all(db);

await from(tasks).where(tasks.scheduledTo, 'BETWEEN', [lastWeek, r.nowUTC()]).all(db);
await from(tasks).where(tasks.attempts, 'NOT BETWEEN', [1, 3]).all(db);

await from(tasks).where(tasks.payload.kind, 'LIKE', 'Prune%').all(db);
await from(tasks).where(tasks.payload.kind, 'NOT ILIKE', '%test%').all(db);

await from(tasks).where(tasks.parentId, 'IS NOT', null).all(db);
await from(tasks).where(tasks.parentId, 'IS DISTINCT FROM', id).all(db); // rows without a parent too
```

`LIKE` is case-sensitive on postgres (except for `t.citext()` columns), and
case-insensitive for ASCII letters on sqlite. Use `ILIKE` to ignore case on
both.

### Regular expressions

`exp.match()` tests text against a regular expression:

```ts
await from(tasks).where(exp.match(tasks.payload.kind, /^N/)).all(db);
await from(tasks).where(exp.match(tasks.payload.kind, /^n/i)).all(db);
```

On postgres it's `~`, or `~*` with the `i` flag, and patterns are postgres'
own flavor of regular expressions. Flags without an equivalent there (`m`,
`s`, `v`, `y`) throw rather than being dropped, and `g`, `d` and `u` don't
change a match.

SQLite has no regular expressions of its own, so `sqlite.connect` adds them:
`REGEXP`, and `regexp_like(text, pattern, flags)` for a regular expression
with flags. Both match the way JavaScript does, every flag included, and can
be used in fragments too.

### Picking columns

```ts
await from(tasks).select({ id: tasks.id, when: tasks.scheduledTo }).all(db);
// → { id: string, when: r.DateTime }[]

await from(tasks).select({ ...tasks, parent: tasks.parentId }).all(db);
// → (Task & { parent: string | null })[]

await from(tasks).select(tasks).all(db);
// → Task[], same as no select at all

await from(tasks).select(tasks.id).all(db);
// → string[], the values themselves

await from(tasks).select({ status: tasks.status }).distinct().all(db);
// → { status: Task['status'] }[], each status once

await from(tasks).select({ ...tasks.omit(['events']) }).all(db);
// → Omit<Task, 'events'>[]
```

`pick` and `omit` narrow a table to some of its columns, to be spread or
selected whole (see [joins](#joins)). `as`, `pick` and `omit` are reserved,
so they can't be column names.

### Comparing columns

```ts
await from(tasks).where(tasks.attempts, '<', tasks.maxAttempts).all(db);
```

### Coalesce

`exp.coalesce()` reads the first of its operands that isn't null. The rest
can be columns or plain values of the first one's type:

```ts
await from(users).select({ seen: exp.coalesce(users.lastLoggedInAt, users.createdAt) }).all(db);
// → { seen: r.DateTime }[]

await from(users).where(exp.coalesce(users.lastLoggedInAt, r.DateTime.parse(0)), '<', lastWeek).all(db);
```

It reads null only when every one of its operands may.

### AND, OR and NOT

```ts
await from(tasks)
  .where(exp.or([
    exp(tasks.status, '=', 'scheduled'),
    exp.and([
      exp(tasks.status, '=', 'running'),
      exp(tasks.attempts, '>', 3),
    ]),
  ]))
  .all(db);

await from(tasks).where(exp.not(exp.match(tasks.payload.kind, /^N/))).all(db);
```

`exp.not()` negates any condition, fragments included. As in SQL, it reads
null (and so filters the row out) where the condition does.

### Embedded fields

Fields of `embedded.one()` columns are referenced like columns:

```ts
await from(tasks)
  .where(tasks.payload.kind, '=', 'Prune')
  .select({ kind: tasks.payload.kind, params: tasks.payload.params })
  .all(db);
// → { kind: string, params: Record<string, unknown> }[]
```

### Raw SQL fragments

```ts
import { f } from '@reasonable-stack/orm';

await from(tasks).where(f`upper(${tasks.payload.kind})`, '=', 'PRUNE').all(db);
```

A fragment can also be a condition of its own, to use any operator your
database has, e.g. postgres' JSON containment:

```ts
await from(tasks).where(f`${tasks.payload} @> ${{ kind: 'Prune' }}`).all(db);

await from(tasks)
  .where(exp.or([
    f`${tasks.payload} @> ${{ params: { days: 30 } }}`,
    exp(tasks.status, '=', 'scheduled'),
  ]))
  .all(db);
```

Interpolated columns are rendered in place, and any other value is passed as
a parameter.

A fragment reads as `unknown`, unless `.as()` gives it a column type. It's
then typed, decoded and compared like a column of that type, while its SQL
stays as written:

```ts
await from(tasks)
  .select({
    doubled: f`${tasks.attempts} * 2`.as(t.integer()),
    retried: f`${tasks.attempts} > ${0}`.as(t.boolean()),
    retries: f`nullif(${tasks.attempts}, ${0})`.as(t.integer().nullable()),
  })
  .all(db);
// → { doubled: number, retried: boolean, retries: number | null }[]

await from(tasks).where(f`${tasks.scheduledTo}`.as(t.timestamp()), '<', r.nowUTC()).all(db);
```


## Group by

```ts
await from(tasks)
  .where(tasks.status, '!=', 'scheduled')
  .groupBy(tasks.status)
  .select({
    status: tasks.status,
    tasks: exp.count(tasks.id),
    attempts: exp.sum(tasks.attempts),
    average: exp.avg(tasks.attempts),
  })
  .all(db);
// → { status: Task['status'], tasks: number, attempts: number, average: number }[]
```

`groupBy` takes a single operand, or a list of them:
`.groupBy([tasks.payload.kind, tasks.status])`.

| aggregate                          | reads                                                     |
| :--------------------------------- | :-------------------------------------------------------- |
| `exp.count(x)`                     | how many rows have `x` not null                           |
| `exp.count.distinct(x)`            | how many distinct values of `x` there are                 |
| `exp.sum(x)`                       | the sum of `x`, `0` for no rows (numeric columns)         |
| `exp.sum.distinct(x)`              | the sum of the distinct values of `x`                     |
| `exp.min(x)` `exp.max(x)`          | the lowest or highest value of `x` (not booleans or JSON) |
| `exp.avg(x)`                       | the average of `x`, as a float (numeric columns)          |
| `exp.collect(table \| projection)` | the group's rows, as a list (see [Joins](#joins))         |

`exp.min()`, `exp.max()` and `exp.avg()` read null only without a `groupBy`
(there may be no rows to aggregate then), or when the values may be null, or
their table's row may be missing in an outer join.

Selecting aggregates next to plain (non-aggregated) columns takes a `groupBy`,
to say which rows each aggregates: postgres refuses the query otherwise, and
sqlite silently reads the columns of an arbitrary row. Without one, the query
throws when it runs:

```ts
await from(tasks).select({ status: tasks.status, tasks: exp.count(tasks.id) }).all(db);
// throws: "status" isn't aggregated, so the query needs a groupBy
```

Aggregates on their own are fine, and aggregate every row.

`having` filters groups the way `where` filters rows:

```ts
await from(tasks)
  .groupBy(tasks.payload.kind)
  .having(exp.count(tasks.id), '>', 10)
  .having(exp.max(tasks.scheduledTo), '<', lastWeek)
  .select({ kind: tasks.payload.kind, latest: exp.max(tasks.scheduledTo) })
  .all(db);
// → { kind: string, latest: r.DateTime }[]
```

It also takes the keys of the projection, which read as whatever is selected
under them, both on their own and inside `exp()`:

```ts
await from(tasks)
  .groupBy([tasks.payload.kind, tasks.status])
  .having('count', '>', 1)
  .having(exp.or([exp('count', '<', 10), exp('attempts', '=', 0)]))
  .select({
    kind: tasks.payload.kind,
    status: tasks.status,
    count: exp.count(tasks.id),
    attempts: exp.sum(tasks.attempts),
  })
  .all(db);
// → { kind: string, status: Task['status'], count: number, attempts: number }[]
```

Keys work before or after `.select(...)`. After it, only the projection's
keys type-check, and a `.select(...)` after them must have the keys they
named. A key the projection doesn't have throws when the query runs.


## Joins

Alias a table to query it more than once:

```ts
const parent = tasks.as('parent');
const child = tasks.as('child');

await from(parent)
  .leftJoin(child, exp(parent.id, '=', child.parentId))
  .where(parent.parentId, 'IS', null)
  .groupBy(parent.id)
  .select({ ...parent, children: exp.count(child.id) })
  .all(db);
// → (Task & { children: number })[]
```

`exp.collect()` collects a table's rows in each group into a list, or
just the columns you pick:

```ts
await from(parent)
  .leftJoin(child, exp(parent.id, '=', child.parentId))
  .where(parent.parentId, 'IS', null)
  .groupBy(parent.id) // aggregating next to the parent's columns needs a groupBy
  .select({
    ...parent,
    children: exp.collect(child),
    summary: exp.collect({ id: child.id, kind: child.payload.kind }),
  })
  .all(db);
// → (Task & { children: Task[], summary: { id: string, kind: string }[] })[]
```

A parent without children gets an empty list.

`innerJoin` only keeps rows with a match, `leftJoin` keeps every row of the
tables joined so far, and `rightJoin` every row of the joined table:

```ts
await from(parent).innerJoin(child, exp(parent.id, '=', child.parentId)).select({ childId: child.id }).all(db);
// → { childId: string }[]

await from(parent).leftJoin(child, exp(parent.id, '=', child.parentId)).select({ childId: child.id }).all(db);
// → { childId: string | null }[]

await from(child).rightJoin(parent, exp(parent.id, '=', child.parentId)).select({ childId: child.id }).all(db);
// → { childId: string | null }[]
```

A join may leave a table's row missing: the left-joined table's where it has
no match, and the rows of the tables joined before a right join (the queried
table's included) where they have none. An inner join never does. Where a row
may be missing, its columns are nullable, and so is the row itself when it's
selected as a whole, under a key of its own:

```ts
await from(child)
  .leftJoin(parent, exp(parent.id, '=', child.parentId))
  .select({ ...child, parent })
  .all(db);
// → (Task & { parent: Task | null })[]
```

A missing row is told apart by its primary key (or any required column)
being null. For a table without one, the row reads null when every one of its
columns is.

Narrowed by `pick` or `omit`, a table selected as a whole reads only the
columns it kept, and is still null when its row is missing, even when the
primary key is left out:

```ts
await from(child)
  .leftJoin(parent, exp(parent.id, '=', child.parentId))
  .select({ ...child.omit(['parentId']), parent: parent.pick(['id', 'status']) })
  .all(db);
// → (Omit<Task, 'parentId'> & { parent: Pick<Task, 'id' | 'status'> | null })[]
```

A query only takes the tables it reads from, so referencing `child` before
joining it is a type error, and throws when the query is built.


## Update

```ts
const updated: Pick<Task, 'id'>[] = await from(tasks)
  .where(tasks.status, '=', 'scheduled')
  .update(db, {
    set: { status: 'running' },
    inc: { attempts: 1 },
    returning: ['id'], // optional, defaults to `true` (full rows)
  });
```


## Delete

```ts
await from(tasks).where(tasks.status, '=', 'succeeded').delete(db);                      // → undefined
await from(tasks).where(tasks.status, '=', 'succeeded').delete(db, { returning: true }); // → Task[]
```

`update` and `delete` refuse joins, `select`, `distinct`, `groupBy`, `having`,
`orderBy`, `limit` and `offset`, so they never touch more rows than the query
suggests.


## Transactions

```ts
await db.transaction(async (tx) => {
  await into(users).values({ email: 'jane@example.com', name: 'Jane' }).insert(tx);

  await tx.transaction(async (savepoint) => {
    // nested transactions use savepoints
  });
});
```

The transaction rolls back if the callback throws.


## Validation

```ts
import { ValidationError } from '@reasonable-stack/orm';

const people = table('people', {
  id: t.uuidv7().generated().primaryKey(),
  name: t.string({ size: 5 }),
  age: t.integer(),
});

try {
  await into(people).values({ name: 'Jane Doe', age: 1.5 }).insert(db);
} catch (error) {
  if (error instanceof ValidationError) {
    error.message; // Failed validation:
                   //   - name: must be at most 5 characters long
                   //   - age: must be an integer
    error.issues;  // [{ message, path: ['name'] }, ...]
  }
}
```


## License

[MIT](LICENSE)
