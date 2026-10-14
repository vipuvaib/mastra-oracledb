import { describe, expect, it } from 'vitest';

import { buildMetadataWhereClause } from './filter';

// Oracle size() returns 1 for scalars and objects as well as singleton arrays.
// These compiler tests require an array guard; database tests must verify actual matches.
describe('buildMetadataWhereClause size filtering', () => {
  it.each(['tags', 'profile.tags'])('requires an array type guard for size-one filtering at %s', path => {
    const filter = buildMetadataWhereClause({ [path]: { $size: 1 } });

    expect(filter.sql).toContain(`'$.${path}?(`);
    expect(filter.sql).toContain('@.type() == "array" && @.size() == $b0');
    expect(filter.binds).toEqual({ b0: 1 });
    expect(filter.match).toBe('filtered');
  });

  it.each([0, 1, 2])('binds array length %i without treating it as an unconditional filter', size => {
    const filter = buildMetadataWhereClause({ tags: { $size: size } });

    expect(filter.sql).toContain('@.size() == $b0');
    expect(filter.sql).toContain('PASSING :b0 AS "b0"');
    expect(filter.binds).toEqual({ b0: size });
    expect(filter.match).toBe('filtered');
  });

  it.each([
    { name: 'negative integers', value: -1 },
    { name: 'fractional numbers', value: 1.5 },
    { name: 'numeric strings', value: '1' },
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'booleans', value: true },
    { name: 'arrays', value: [] },
    { name: 'empty objects', value: {} },
    { name: 'comparison objects', value: { $gt: 1 } },
    { name: 'NaN', value: NaN },
    { name: 'Infinity', value: Infinity },
  ])('rejects $name as an array length', ({ value }) => {
    // Deliberately supply invalid runtime values despite the public number type.
    expect(() => buildMetadataWhereClause({ tags: { $size: value as number } })).toThrow(
      /\$size requires a non-negative integer/i,
    );
  });
});
