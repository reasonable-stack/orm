import { describe, expect, test } from 'bun:test';
import * as r from '@reasonable-stack/datetime';
import * as std from '../src/standard-schema';

const ok = (schema: std.Schema, input: unknown) => expect(std.parse(schema, input)).toEqual({ value: input });
const ko = (schema: std.Schema, input: unknown) => expect(std.parse(schema, input).issues).toBeArray();

describe('standard-schema', () => {
  test('number accepts zero and negatives', () => {
    ok(std.number(), 0);
    ok(std.number(), -1.5);
    ko(std.number(), Number.NaN);
    ko(std.number(), Infinity);
    ko(std.number(), '1');
  });

  test('integer stays within the safe range', () => {
    ok(std.integer(), 2 ** 40);
    ko(std.integer(), 1.5);
    ko(std.integer(), 2 ** 53);
  });

  test('dateTime coerces ISO strings and epoch milliseconds', () => {
    ok(std.dateTime(), r.DateTime.parse('2026-11-12T00:00:00Z'));
    expect(std.parse(std.dateTime(), '2026-11-12T00:00:00-03:00')).toEqual({ value: r.DateTime.parse('2026-11-12T00:00:00-03:00') });
    expect(std.parse(std.dateTime(), 0)).toEqual({ value: r.DateTime.parse(0) });
    ko(std.dateTime(), 'yesterday');
    ko(std.dateTime(), '2026-11-12T00:00:00');
    ko(std.dateTime(), 1.5);
    ko(std.dateTime(), new Date());
  });

  test('date coerces ISO strings, rejecting impossible dates', () => {
    ok(std.date(), r.Date.parse('2024-02-29'));
    expect(std.parse(std.date(), '2024-02-29')).toEqual({ value: r.Date.parse('2024-02-29') });
    ko(std.date(), '2026-02-29');
    ko(std.date(), '2026-1-1');
    ko(std.date(), r.DateTime.parse(0));
    ko(std.date(), new Date());
  });

  test('uuid, enumOf, string, boolean and instanceOf', () => {
    ok(std.uuid(), '019a7b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b');
    ko(std.uuid(), 'not-a-uuid');
    ok(std.enumOf(['a', 'b']), 'a');
    ko(std.enumOf(['a', 'b']), 'c');
    ok(std.string({ max: 2 }), 'ab');
    ko(std.string({ max: 2 }), 'abc');
    ok(std.boolean(), false);
    ko(std.boolean(), 0);
    ok(std.instanceOf(Uint8Array), new Uint8Array());
    ko(std.instanceOf(Uint8Array), [1]);
  });

  test('record takes plain objects only', () => {
    ok(std.record(), {});
    ok(std.record(), { a: [1] });
    ko(std.record(), []);
    ko(std.record(), null);
    ko(std.record(), new Date());
  });

  test('nullable and optional', () => {
    ok(std.nullable(std.string()), null);
    ko(std.nullable(std.string()), undefined);
    ok(std.optional(std.string()), undefined);
    ko(std.optional(std.string()), null);
  });

  test('strictObject reports unknown and missing keys without throwing', () => {
    const schema = std.strictObject({ a: std.string(), b: std.optional(std.number()) });

    expect(std.parse(schema, { a: 'x' })).toEqual({ value: { a: 'x' } });
    expect(std.parse(schema, { b: 'y', c: 1 }).issues).toEqual([
      { path: ['c'], message: 'unknown field' },
      { path: ['a'], message: 'is required' },
      { path: ['b'], message: 'must be a finite number' },
    ]);
  });

  test('parseOrThrow throws a ValidationError with readable paths', () => {
    const schema = std.array(std.strictObject({ a: std.string() }));

    expect(() => std.parseOrThrow(schema, [{ a: 'x' }, { a: 1 }])).toThrow(new std.ValidationError([{ path: [1, 'a'], message: 'must be a string' }]));
    expect(() => std.parseOrThrow(schema, [{ a: 1 }])).toThrow('0.a: must be a string');
  });

  test('async validators are rejected', () => {
    const async: std.Schema = { '~standard': { version: 1, vendor: 'x', validate: async () => ({ value: 1 }) } };
    expect(() => std.parse(async, 1)).toThrow('async standard schema validators are not supported');
  });
});
