import { describe, expect, it } from 'vitest';

import { buildMetadataWhereClause } from './filter';

const ranges = [
  { operator: '$gt', symbol: '>' },
  { operator: '$gte', symbol: '>=' },
  { operator: '$lt', symbol: '<' },
  { operator: '$lte', symbol: '<=' },
] as const;

// These tests establish the proposed scalar range contract. Database result tests
// separately verify stored-type eligibility and SQL NULL behavior under negation.
describe('buildMetadataWhereClause scalar range filtering', () => {
  describe.each(['value', 'profile.value'])('field %s', path => {
    it.each(ranges)('requires stored JSON numbers for numeric $operator operands', ({ operator, symbol }) => {
      const filter = buildMetadataWhereClause({ [path]: { [operator]: 10 } });

      expect(filter.sql).toContain(`metadata, '$.${path}`);
      expect(filter.sql).toContain('@.type() == "number"');
      expect(filter.sql).toContain('RETURNING NUMBER NULL ON ERROR');
      expect(filter.sql).toContain(`${symbol} :b0`);
      expect(filter.binds).toEqual({ b0: 10 });
      expect(filter.match).toBe('filtered');
    });

    describe.each(['root', 'field'] as const)('%s negation', negation => {
      it.each(ranges)('preserves SQL NULL for incompatible metadata with $operator', ({ operator }) => {
        const condition = { [operator]: 10 };
        const filter = buildMetadataWhereClause(
          negation === 'root' ? { $not: { [path]: condition } } : { [path]: { $not: condition } },
        );

        expect(filter.sql).toContain('NOT (');
        expect(filter.sql).toContain('@.type() == "number"');
        // A false type guard alone would become true under NOT. Incompatible
        // values must take a NULL branch so neither positive nor negated filters match.
        expect(filter.sql).toMatch(/CASE[\s\S]*THEN[\s\S]*ELSE\s+NULL\s+END/i);
        expect(filter.binds).toEqual({ b0: 10 });
        expect(filter.match).toBe('filtered');
      });
    });

    it.each(ranges)('keeps numeric-looking string operands textual for $operator', ({ operator, symbol }) => {
      const filter = buildMetadataWhereClause({ [path]: { [operator]: '10' } });

      expect(filter.sql).toContain(
        `JSON_VALUE(metadata, '$.${path}' RETURNING VARCHAR2(4000) NULL ON ERROR) ${symbol} :b0`,
      );
      expect(filter.sql).not.toContain('JSON_EXISTS');
      expect(filter.sql).not.toContain('RETURNING NUMBER');
      expect(filter.binds).toEqual({ b0: '10' });
      expect(filter.match).toBe('filtered');
    });
  });
});
