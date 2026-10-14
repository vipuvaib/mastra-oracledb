import { describe, expect, it } from 'vitest';

import { buildMetadataWhereClause } from './filter';

// Live Oracle tests establish matching and negation; these check the compiler boundary
// without changing the shared membership helpers used by $all, $in, and $nin.
describe('buildMetadataWhereClause array contains filtering', () => {
  describe.each(['tags', 'profile.tags'])('field %s', path => {
    const arrayGuard = `JSON_EXISTS(metadata, '$.${path}?(@.type() == "array")')`;
    const membership = (name: string) =>
      `JSON_EXISTS(metadata, '$.${path}[*]?(@ == $${name})' PASSING :${name} AS "${name}")`;
    const operands = [
      { name: 'singleton', values: ['premium'], binds: { b0: 'premium' } },
      { name: 'two elements', values: ['premium', 'vip'], binds: { b0: 'premium', b1: 'vip' } },
    ];

    it.each(operands)(
      'requires an actual array and every requested element for $name operands',
      ({ values, binds }) => {
        const filter = buildMetadataWhereClause({ [path]: { $contains: values } });

        expect(filter.sql).toContain(arrayGuard);
        expect(filter.sql).toContain(' AND ');
        expect(filter.sql).toContain(membership('b0'));
        if (values.length === 2) expect(filter.sql).toContain(membership('b1'));
        expect(filter.binds).toEqual(binds);
        expect(filter.match).toBe('filtered');
      },
    );

    describe.each(['root', 'field'] as const)('%s negation', negation => {
      it.each(operands)(
        'negates the array boundary together with all membership checks for $name',
        ({ values, binds }) => {
          const condition = { $contains: values };
          const filter = buildMetadataWhereClause(
            negation === 'root' ? { $not: { [path]: condition } } : { [path]: { $not: condition } },
          );

          expect(filter.sql).toContain('NOT (');
          expect(filter.sql).toContain(arrayGuard);
          expect(filter.sql).toContain(' AND ');
          expect(filter.sql).toContain(membership('b0'));
          if (values.length === 2) expect(filter.sql).toContain(membership('b1'));
          // Non-arrays yield FALSE here, so negation includes them. This differs
          // deliberately from numeric ranges' nullable type guard.
          expect(filter.sql).not.toContain('ELSE NULL');
          expect(filter.binds).toEqual(binds);
          expect(filter.match).toBe('filtered');
        },
      );
    });

    it('keeps empty contains operands bind-free and unconditional', () => {
      const filter = buildMetadataWhereClause({ [path]: { $contains: [] } });

      expect(filter.sql).toContain('1 = 1');
      expect(filter.sql).not.toContain(arrayGuard);
      expect(filter.binds).toEqual({});
      expect(filter.match).toBe('match-all');
    });

    it.each(['root', 'field'] as const)('keeps %s negated empty contains operands match-none', negation => {
      const condition = { $contains: [] };
      const filter = buildMetadataWhereClause(
        negation === 'root' ? { $not: { [path]: condition } } : { [path]: { $not: condition } },
      );

      expect(filter.sql).toContain('NOT (');
      expect(filter.sql).toContain('1 = 1');
      expect(filter.sql).not.toContain(arrayGuard);
      expect(filter.binds).toEqual({});
      expect(filter.match).toBe('match-none');
    });

    it('keeps string contains using scalar substring OR exact element membership', () => {
      const filter = buildMetadataWhereClause({ [path]: { $contains: 'Premium' } });

      expect(filter.sql).toContain(
        `LOWER(JSON_VALUE(metadata, '$.${path}' RETURNING VARCHAR2(4000) NULL ON ERROR)) LIKE '%' || :b0 || '%'`,
      );
      expect(filter.sql).toContain(' OR ');
      expect(filter.sql).toContain(membership('b1'));
      expect(filter.sql).not.toContain(arrayGuard);
      expect(filter.binds).toEqual({ b0: 'premium', b1: 'Premium' });
      expect(filter.match).toBe('filtered');
    });

    it('keeps all on its existing unguarded membership path', () => {
      const filter = buildMetadataWhereClause({ [path]: { $all: ['premium'] } });

      expect(filter.sql).toContain(membership('b0'));
      expect(filter.sql).not.toContain(arrayGuard);
      expect(filter.binds).toEqual({ b0: 'premium' });
      expect(filter.match).toBe('filtered');
    });

    it('keeps in combining scalar and element membership', () => {
      const filter = buildMetadataWhereClause({ [path]: { $in: ['premium'] } });

      expect(filter.sql).toContain('IN (:b0)');
      expect(filter.sql).toContain(' OR ');
      expect(filter.sql).toContain(membership('b1'));
      expect(filter.sql).not.toContain(arrayGuard);
      expect(filter.binds).toEqual({ b0: 'premium', b1: 'premium' });
      expect(filter.match).toBe('filtered');
    });

    it('keeps nin using its existing array bypass and scalar comparison', () => {
      const filter = buildMetadataWhereClause({ [path]: { $nin: ['premium'] } });

      expect(filter.sql).toContain(`CASE WHEN ${arrayGuard} THEN 1 WHEN `);
      expect(filter.sql).toContain('NOT IN (:b0)');
      expect(filter.sql).toContain(`AND NOT (${membership('b1')})`);
      expect(filter.binds).toEqual({ b0: 'premium', b1: 'premium' });
      expect(filter.match).toBe('filtered');
    });
  });
});
