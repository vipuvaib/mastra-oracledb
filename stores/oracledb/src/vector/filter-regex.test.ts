import { describe, expect, it } from 'vitest';

import { buildMetadataWhereClause } from './filter';

// Matching semantics are covered against Oracle in index.integration.test.ts.
// These tests cover invalid input that must fail before SQL execution.
describe('buildMetadataWhereClause regex validation', () => {
  describe.each(['g', 'y', 'u'])('unsupported RegExp flag %s', flag => {
    it('rejects a direct RegExp instead of silently dropping the flag', () => {
      expect(() => buildMetadataWhereClause({ value: new RegExp('oracle', flag) } as any)).toThrow(
        /unsupported.*(?:regex|regular expression).*flag/i,
      );
    });

    it('rejects a RegExp inside $regex instead of stringifying it', () => {
      expect(() => buildMetadataWhereClause({ value: { $regex: new RegExp('oracle', flag) } })).toThrow(
        /unsupported.*(?:regex|regular expression).*flag/i,
      );
    });
  });

  it.each(['g', 'y', 'u', 'x', 'z', 'ig'])('rejects unsupported $options flags %s explicitly', options => {
    expect(() => buildMetadataWhereClause({ value: { $regex: 'oracle', $options: options } })).toThrow(
      /unsupported.*(?:regex|regular expression).*flag/i,
    );
  });

  it('reports that $options requires $regex', () => {
    expect(() => buildMetadataWhereClause({ value: { $options: 'i' } })).toThrow(
      /\$options.*(?:requires|without).*\$regex/i,
    );
  });

  it('makes default case sensitivity explicit instead of inheriting database collation', () => {
    const filter = buildMetadataWhereClause({ value: { $regex: 'oracle' } });

    expect(filter.sql).toContain(":b0, 'c')");
    expect(filter.binds).toEqual({ b0: 'oracle' });
    expect(filter.match).toBe('filtered');
  });

  it('combines RegExp flags with $options without serializing the RegExp', () => {
    const filter = buildMetadataWhereClause({ value: { $regex: /oracle/i, $options: 'msi' } });

    expect(filter.sql).toContain(":b0, 'imn')");
    expect(filter.binds).toEqual({ b0: 'oracle' });
    expect(filter.match).toBe('filtered');
  });

  it('combines the existing (?i) form with $options', () => {
    const filter = buildMetadataWhereClause({ value: { $regex: '(?i)oracle', $options: 'm' } });

    expect(filter.sql).toContain(":b0, 'im')");
    expect(filter.binds).toEqual({ b0: 'oracle' });
  });

  it('normalizes regex options inside field-level $not while keeping sibling predicates', () => {
    const filter = buildMetadataWhereClause({
      value: { $not: { $regex: 'oracle', $options: 's', $ne: 'blocked' } },
    });

    expect(filter.sql).toContain('NOT (');
    expect(filter.sql).toContain(":b0, 'cn')");
    expect(filter.sql).toContain(' AND ');
    expect(filter.sql).toContain('<> :b1');
    expect(filter.binds).toEqual({ b0: 'oracle', b1: 'blocked' });
    expect(filter.match).toBe('filtered');
  });

  it.each([{ options: null }, { options: 1 }, { options: ['i'] }])(
    'rejects non-string $options $options',
    ({ options }) => {
      expect(() => buildMetadataWhereClause({ value: { $regex: 'oracle', $options: options } } as any)).toThrow(
        /\$options.*string/i,
      );
    },
  );

  it.each([null, 1, {}])('rejects invalid $regex operands %j', pattern => {
    expect(() => buildMetadataWhereClause({ value: { $regex: pattern } } as any)).toThrow(/\$regex.*string.*RegExp/i);
  });
});
