import { z } from 'zod/v4';
import { type Infer, defineType, embedded, table, t } from '../src';
import { create, register } from '../src/experimental-migrations';

// ─── custom types ────────────────────────────────────────────────────────────

export const tc = {
  email: () => defineType({ primitive: 'STRING', schema: z.email() }),
};

// ─── schema ──────────────────────────────────────────────────────────────────

export type Status = 'scheduled' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type EventKind = 'scheduled' | 'queued' | 'started' | 'succeeded' | 'failed' | 'canceled' | 'rescued';

export type Task = Infer<typeof tasks>;
export type TaskInsert = Infer<typeof tasks, 'insert'>;
export type TaskUpdate = Infer<typeof tasks, 'update'>;

// the oracle's tasks, plus the columns the rest of the suite leans on
export const tasks = table('tasks', {
  id: t.uuidv7().generated().primaryKey(),
  parentId: t.uuidv7().nullable(),
  status: t.enum(['scheduled', 'queued', 'running', 'succeeded', 'failed', 'canceled']),
  attempts: t.integer().unsigned().default(0),
  maxAttempts: t.integer().unsigned().default(3),
  payload: embedded.one({
    kind: t.string(),
    params: t.record().default({}),
  }),
  events: embedded.many({
    kind: t.enum(['scheduled', 'queued', 'started', 'succeeded', 'failed', 'canceled', 'rescued']),
    data: t.record().default({}),
    timestamp: t.timestamp().default(() => Temporal.Now.instant()),
  }),
  createdAt: t.timestamp().default(() => Temporal.Now.instant()),
  updatedAt: t.timestamp().default(() => Temporal.Now.instant()),
  scheduledTo: t.timestamp().default(() => Temporal.Now.instant()),
});

export type User = Infer<typeof users>;
export type UserInsert = Infer<typeof users, 'insert'>;
export type UserUpdate = Infer<typeof users, 'update'>;

export const users = table('users', {
  id: t.uuidv7().generated().primaryKey(),
  name: t.string(),
  email: tc.email(),
  logins: t.integer().unsigned().default(0),
  createdAt: t.timestamp().default(() => Temporal.Now.instant()),
  updatedAt: t.timestamp().default(() => Temporal.Now.instant()),
  lastLoggedInAt: t.timestamp().nullable(),
});

// ─── migrations ──────────────────────────────────────────────────────────────

export const migrate = register({
  '0001': async (db) => {
    await create.table(tasks).run(db);
    await create.index('tasks_status_scheduled_to_idx', { table: 'tasks', columns: ['status', 'scheduled_to'] }).run(db);
  },
  '0002': async (db) => {
    await create.table(users).run(db);
    await create.index('users_email_idx', { table: 'users', columns: ['email'], unique: true }).run(db);
  },
});

// ─── rows ────────────────────────────────────────────────────────────────────

// instants to the millisecond, as they are stored
const now = () => Temporal.Instant.fromEpochMilliseconds(Date.now());
export const minutesAgo = (n: number) => now().subtract({ minutes: n });
export const minutesFromNow = (n: number) => now().add({ minutes: n });

// the smallest valid task, overridable field by field
export const task = (overrides: Partial<TaskInsert> = {}): TaskInsert => ({
  status: 'scheduled',
  payload: { kind: 'Prune' },
  events: [{ kind: 'scheduled' }],
  ...overrides,
});

export const jane = { name: 'Jane Doe', email: 'jane.doe@example.com' } satisfies UserInsert;
