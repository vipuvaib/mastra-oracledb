import { describe, expect, it } from 'vitest';

import { buildMetadataWhereClause } from './filter';

describe('buildMetadataWhereClause null equality', () => {
  describe.each(['value', 'profile.value'])('field %s', path => {
    it.each(['$eq', '$ne'] as const)('avoids lossy scalar NULL checks for %s', operator => {
      const filter = buildMetadataWhereClause({ [path]: { [operator]: null } });
      const scalarNullCheck =
        `JSON_VALUE(metadata, '$.${path}' RETURNING VARCHAR2(4000) NULL ON ERROR) ` +
        (operator === '$eq' ? 'IS NULL' : 'IS NOT NULL');

      // Scalar extraction cannot distinguish JSON null/missing from arrays,
      // objects, or empty strings. The result tests establish the required semantics.
      expect(filter.sql).not.toContain(scalarNullCheck);
      const exists = `JSON_EXISTS(metadata, '$.${path}')`;
      const isNull = `JSON_EXISTS(metadata, '$.${path}?(@.type() == "null")')`;
      expect(filter.sql).toContain(
        operator === '$eq' ? `(NOT ${exists} OR ${isNull})` : `(${exists} AND NOT ${isNull})`,
      );
      expect(filter.binds).toEqual({});
      expect(filter.match).toBe('filtered');
    });
  });

  it('keeps direct null values on the same path with the same binds and classification as explicit equality', () => {
    const direct = buildMetadataWhereClause({ value: null });
    const explicit = buildMetadataWhereClause({ value: { $eq: null } });

    const nullEquality =
      "(NOT JSON_EXISTS(metadata, '$.value') OR JSON_EXISTS(metadata, '$.value?(@.type() == \"null\")'))";
    expect(direct.sql).toContain(nullEquality);
    expect(explicit.sql).toContain(nullEquality);
    expect(direct.binds).toEqual(explicit.binds);
    expect(direct.match).toBe(explicit.match);
  });

  it.each([
    { operator: '$eq', symbol: '=' },
    { operator: '$ne', symbol: '<>' },
  ])('keeps non-null string comparisons using $operator unchanged', ({ operator, symbol }) => {
    const filter = buildMetadataWhereClause({ value: { [operator]: 'present' } });

    expect(filter.sql).toContain(
      `JSON_VALUE(metadata, '$.value' RETURNING VARCHAR2(4000) NULL ON ERROR) ${symbol} :b0`,
    );
    expect(filter.binds).toEqual({ b0: 'present' });
    expect(filter.match).toBe('filtered');
  });

  it('preserves Oracle existence checks independently of null equality', () => {
    const exists = buildMetadataWhereClause({ value: { $exists: true } });
    const absent = buildMetadataWhereClause({ value: { $exists: false } });

    expect(exists.sql).toContain("JSON_EXISTS(metadata, '$.value')");
    expect(absent.sql).toContain("NOT JSON_EXISTS(metadata, '$.value')");
    expect(exists.binds).toEqual({});
    expect(absent.binds).toEqual({});
    expect(exists.match).toBe('filtered');
    expect(absent.match).toBe('filtered');
  });
});
