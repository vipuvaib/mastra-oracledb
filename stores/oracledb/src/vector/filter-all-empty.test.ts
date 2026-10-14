import { describe, expect, it } from 'vitest';

import { buildMetadataWhereClause } from './filter';
import type { FilterMatch } from './filter';
import type { OracleVectorFilter } from './types';

describe('buildMetadataWhereClause empty all filtering', () => {
  it.each(['tags', 'profile.tags'])('compiles an empty all list at %s to a bind-free match-none predicate', path => {
    const filter = buildMetadataWhereClause({ [path]: { $all: [] } });

    expect(filter.sql).toContain('1 = 0');
    expect(filter.sql).not.toContain('1 = 1');
    expect(filter.binds).toEqual({});
    expect(filter.match).toBe('match-none');
  });

  const cases: { name: string; filter: OracleVectorFilter; match: FilterMatch }[] = [
    {
      name: 'AND with a field predicate',
      filter: { $and: [{ tags: { $all: [] } }, { kind: 'selected' }] },
      match: 'match-none',
    },
    {
      name: 'OR with a field predicate',
      filter: { $or: [{ tags: { $all: [] } }, { kind: 'selected' }] },
      match: 'filtered',
    },
    { name: 'root NOT', filter: { $not: { tags: { $all: [] } } }, match: 'match-all' },
    { name: 'field NOT', filter: { tags: { $not: { $all: [] } } }, match: 'match-all' },
    { name: 'NOR', filter: { $nor: [{ tags: { $all: [] } }] }, match: 'match-all' },
  ];

  it.each(cases)('propagates match-none through $name', ({ filter, match }) => {
    const result = buildMetadataWhereClause(filter);

    expect(result.match).toBe(match);
    expect(result.sql).toContain('1 = 0');
  });

  it('preserves the current empty contains behavior independently of empty all', () => {
    const filter = buildMetadataWhereClause({ tags: { $contains: [] } });

    expect(filter.sql).toContain('1 = 1');
    expect(filter.binds).toEqual({});
    expect(filter.match).toBe('match-all');
  });

  it('keeps nonempty all requiring every requested array element', () => {
    const filter = buildMetadataWhereClause({ tags: { $all: ['oracle', 'mastra'] } });

    expect(filter.sql).toContain('JSON_EXISTS(metadata, \'$.tags[*]?(@ == $b0)\' PASSING :b0 AS "b0")');
    expect(filter.sql).toContain('JSON_EXISTS(metadata, \'$.tags[*]?(@ == $b1)\' PASSING :b1 AS "b1")');
    expect(filter.sql).toContain(' AND ');
    expect(filter.binds).toEqual({ b0: 'oracle', b1: 'mastra' });
    expect(filter.match).toBe('filtered');
  });

  it('preserves the opposite truth values of empty in and empty nin', () => {
    expect(buildMetadataWhereClause({ tags: { $in: [] } }).match).toBe('match-none');
    expect(buildMetadataWhereClause({ tags: { $nin: [] } }).match).toBe('match-all');
  });
});
