import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createVectorTestSuite } from '../../../_test-utils/src';
import { OracleStore } from '../storage';
import { qualifyName, tableNameForIndex } from './identifiers';
import type { OracleVectorFilter } from './types';
import { OracleVector } from '.';

// Oracle integration coverage stays opt-in because it requires a reachable database and credentials.
const runIntegration = process.env.RUN_ORACLE_VECTOR_INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;

if (runIntegration) {
  // The shared suite keeps Oracle behavior aligned with Mastra's other vector providers.
  const sharedSuiteVector = new OracleVector({
    id: 'oracle-vector-shared-suite',
    user: process.env.ORACLE_DATABASE_USER,
    password: process.env.ORACLE_DATABASE_PASSWORD,
    connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
    tablePrefix: 'ORACLE_SUITE_VEC',
    defaultIndexConfig: { type: 'none' },
  });

  createVectorTestSuite({
    vector: sharedSuiteVector,
    createIndex: async (indexName, options) => {
      await sharedSuiteVector.createIndex({
        indexName,
        dimension: 1536,
        metric: options?.metric,
        buildIndex: false,
      });
    },
    deleteIndex: async indexName => {
      await sharedSuiteVector.deleteIndex({ indexName });
    },
    waitForIndexing: async () => {},
    disconnect: async () => {
      await sharedSuiteVector.disconnect();
    },
    supportsZeroVectors: false,
  });
}

// Assert database results rather than SQL shape: JSON_VALUE returns SQL NULL for arrays,
// so combining scalar NOT IN with array exclusion using AND can hide valid matches.
describeIntegration('OracleVector $nin compatibility', () => {
  const fixtures: { id: string; metadata: Record<string, unknown> }[] = [
    { id: 'text-array-allowed', metadata: { cohort: 'text', tags: ['allowed', 'other'] } },
    { id: 'text-array-mixed', metadata: { cohort: 'text', tags: ['blocked', 'allowed'] } },
    { id: 'text-array-blocked', metadata: { cohort: 'text', tags: ['blocked'] } },
    { id: 'text-array-empty', metadata: { cohort: 'text', tags: [] } },
    { id: 'text-array-null', metadata: { cohort: 'text', tags: [null, 'allowed'] } },
    { id: 'text-scalar-allowed', metadata: { cohort: 'text', tags: 'allowed' } },
    { id: 'text-scalar-blocked', metadata: { cohort: 'text', tags: 'blocked' } },
    { id: 'text-null', metadata: { cohort: 'text', tags: null } },
    { id: 'text-missing', metadata: { cohort: 'text' } },
    { id: 'number-array-allowed', metadata: { cohort: 'number', tags: [2, 3] } },
    { id: 'number-array-mixed', metadata: { cohort: 'number', tags: [1, 2] } },
    { id: 'number-array-empty', metadata: { cohort: 'number', tags: [] } },
    { id: 'number-scalar-allowed', metadata: { cohort: 'number', tags: 2 } },
    { id: 'number-scalar-blocked', metadata: { cohort: 'number', tags: 1 } },
    { id: 'number-null', metadata: { cohort: 'number', tags: null } },
    { id: 'number-missing', metadata: { cohort: 'number' } },
    { id: 'mixed-array-allowed', metadata: { cohort: 'mixed', tags: ['allowed', 2] } },
    { id: 'mixed-array-blocked-string', metadata: { cohort: 'mixed', tags: ['blocked', 2] } },
    { id: 'mixed-array-blocked-number', metadata: { cohort: 'mixed', tags: ['allowed', 1] } },
    { id: 'mixed-array-blocked-both', metadata: { cohort: 'mixed', tags: ['blocked', 1] } },
    { id: 'mixed-array-empty', metadata: { cohort: 'mixed', tags: [] } },
    { id: 'absent-null', metadata: { cohort: 'absent', tags: null } },
    { id: 'absent-missing', metadata: { cohort: 'absent' } },
  ];

  // Reuse the same values at a nested path to check path handling independently of membership.
  const metadata = fixtures.map(fixture => ({
    ...fixture.metadata,
    profile: Object.hasOwn(fixture.metadata, 'tags') ? { tags: fixture.metadata.tags } : {},
  }));
  const cases: { name: string; filter: OracleVectorFilter; expectedIds: string[] }[] = [
    {
      name: 'matches allowed string arrays, empty arrays, and scalars while excluding any blocked element',
      filter: { cohort: 'text', tags: { $nin: ['blocked'] } },
      expectedIds: ['text-array-allowed', 'text-array-empty', 'text-array-null', 'text-scalar-allowed'],
    },
    {
      name: 'checks every excluded value against every array element',
      filter: { cohort: 'text', tags: { $nin: ['blocked', 'other'] } },
      expectedIds: ['text-array-empty', 'text-array-null', 'text-scalar-allowed'],
    },
    {
      name: 'matches allowed numeric arrays, empty arrays, and scalars',
      filter: { cohort: 'number', tags: { $nin: [1] } },
      expectedIds: ['number-array-allowed', 'number-array-empty', 'number-scalar-allowed'],
    },
    {
      name: 'supports mixed exclusion values with a string first',
      filter: { cohort: 'mixed', tags: { $nin: ['blocked', 1] } },
      expectedIds: ['mixed-array-allowed', 'mixed-array-empty'],
    },
    {
      name: 'supports mixed exclusion values with a number first',
      filter: { cohort: 'mixed', tags: { $nin: [1, 'blocked'] } },
      expectedIds: ['mixed-array-allowed', 'mixed-array-empty'],
    },
    {
      name: 'applies the same membership rules to a nested metadata path',
      filter: { cohort: 'text', 'profile.tags': { $nin: ['blocked'] } },
      expectedIds: ['text-array-allowed', 'text-array-empty', 'text-array-null', 'text-scalar-allowed'],
    },
    {
      name: 'matches every value, including missing fields and JSON nulls, for an empty exclusion list',
      filter: { cohort: 'text', tags: { $nin: [] } },
      expectedIds: fixtures.filter(fixture => fixture.metadata.cohort === 'text').map(fixture => fixture.id),
    },
    {
      name: 'excludes missing fields and scalar JSON nulls for a nonempty exclusion list',
      filter: { cohort: 'absent', tags: { $nin: ['blocked'] } },
      expectedIds: [],
    },
    {
      name: 'keeps positive $in matching scalars and arrays that contain an included element',
      filter: { cohort: 'text', tags: { $in: ['blocked'] } },
      expectedIds: ['text-array-mixed', 'text-array-blocked', 'text-scalar-blocked'],
    },
  ];

  let vector: OracleVector;
  let indexCreated = false;
  const indexName = `oracle_nin_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    vector = new OracleVector({
      id: 'oracle-vector-nin-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_NIN_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    await vector.createIndex({ indexName, dimension: 3, metric: 'cosine', buildIndex: false });
    indexCreated = true;
    await vector.upsert({
      indexName,
      ids: fixtures.map(fixture => fixture.id),
      vectors: fixtures.map(() => [0.1, 0.2, 0.3]),
      metadata,
    });
  }, 60_000);

  afterAll(async () => {
    if (!vector) return;
    try {
      if (indexCreated) await vector.deleteIndex({ indexName });
    } finally {
      await vector.disconnect();
    }
  }, 60_000);

  describe.each(['metadata-only', 'vector-search'] as const)('%s queries', mode => {
    it.each(cases)('$name', async ({ filter, expectedIds }) => {
      const results = await vector.query({
        indexName,
        filter,
        topK: fixtures.length,
        ...(mode === 'vector-search' ? { queryVector: [0.1, 0.2, 0.3], queryMode: 'exact' as const } : {}),
      });

      // All matches fit within topK; ordering is irrelevant to membership.
      expect(results.map(result => result.id).sort()).toEqual([...expectedIds].sort());
    });
  });
});

// Oracle size() also returns 1 for scalars and objects. Only JSON arrays should
// match Mastra's size filter, regardless of their element types or field path.
describeIntegration('OracleVector $size compatibility', () => {
  const fixtures: { id: string; metadata: Record<string, unknown> }[] = [
    { id: 'array-empty', metadata: { tags: [] } },
    { id: 'array-one-string', metadata: { tags: ['allowed'] } },
    { id: 'array-one-null', metadata: { tags: [null] } },
    { id: 'array-one-object', metadata: { tags: [{ label: 'allowed' }] } },
    { id: 'array-one-array', metadata: { tags: [[]] } },
    { id: 'array-two-values', metadata: { tags: ['allowed', 'other'] } },
    { id: 'array-two-arrays', metadata: { tags: [[], [1]] } },
    { id: 'array-three-values', metadata: { tags: [1, 'allowed', null] } },
    { id: 'scalar-string', metadata: { tags: 'allowed' } },
    { id: 'scalar-empty-string', metadata: { tags: '' } },
    { id: 'scalar-number', metadata: { tags: 42 } },
    { id: 'scalar-true', metadata: { tags: true } },
    { id: 'scalar-false', metadata: { tags: false } },
    { id: 'object-empty', metadata: { tags: {} } },
    { id: 'object-one-field', metadata: { tags: { label: 'allowed' } } },
    { id: 'object-two-fields', metadata: { tags: { first: 1, second: 2 } } },
    { id: 'json-null', metadata: { tags: null } },
    { id: 'missing-field', metadata: {} },
    { id: 'missing-parent', metadata: {} },
    { id: 'null-parent', metadata: { profile: null } },
    { id: 'scalar-parent', metadata: { profile: 'allowed' } },
  ];
  const metadata = fixtures.map(fixture => {
    if (fixture.id === 'missing-parent' || Object.hasOwn(fixture.metadata, 'profile')) return fixture.metadata;
    return {
      ...fixture.metadata,
      profile: Object.hasOwn(fixture.metadata, 'tags') ? { tags: fixture.metadata.tags } : {},
    };
  });
  const cases = [
    { size: 0, expectedIds: ['array-empty'] },
    { size: 1, expectedIds: ['array-one-string', 'array-one-null', 'array-one-object', 'array-one-array'] },
    { size: 2, expectedIds: ['array-two-values', 'array-two-arrays'] },
  ];

  let vector: OracleVector;
  let indexCreated = false;
  const indexName = `oracle_size_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    vector = new OracleVector({
      id: 'oracle-vector-size-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_SIZE_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    await vector.createIndex({ indexName, dimension: 3, metric: 'cosine', buildIndex: false });
    indexCreated = true;
    await vector.upsert({
      indexName,
      ids: fixtures.map(fixture => fixture.id),
      vectors: fixtures.map(() => [0.1, 0.2, 0.3]),
      metadata,
    });
  }, 60_000);

  afterAll(async () => {
    if (!vector) return;
    try {
      if (indexCreated) await vector.deleteIndex({ indexName });
    } finally {
      await vector.disconnect();
    }
  }, 60_000);

  describe.each(['tags', 'profile.tags'])('field %s', path => {
    describe.each(['metadata-only', 'vector-search'] as const)('%s queries', mode => {
      it.each(cases)('matches only arrays with length $size', async ({ size, expectedIds }) => {
        const results = await vector.query({
          indexName,
          filter: { [path]: { $size: size } },
          topK: fixtures.length,
          ...(mode === 'vector-search' ? { queryVector: [0.1, 0.2, 0.3], queryMode: 'exact' as const } : {}),
        });

        // Include every possible match so extra scalar/object rows cannot hide behind topK.
        expect(results.map(result => result.id).sort()).toEqual([...expectedIds].sort());
      });
    });
  });
});

describeIntegration('OracleVector empty $all compatibility', () => {
  const fixtures: { id: string; metadata: Record<string, unknown> }[] = [
    { id: 'array-both', metadata: { tags: ['oracle', 'mastra'], kind: 'selected' } },
    { id: 'array-one', metadata: { tags: ['oracle'], kind: 'other' } },
    { id: 'array-empty', metadata: { tags: [], kind: 'other' } },
    { id: 'scalar-string', metadata: { tags: 'oracle', kind: 'other' } },
    { id: 'scalar-number', metadata: { tags: 42, kind: 'other' } },
    { id: 'scalar-boolean', metadata: { tags: true, kind: 'other' } },
    { id: 'object', metadata: { tags: { tier: 'gold' }, kind: 'other' } },
    { id: 'json-null', metadata: { tags: null, kind: 'other' } },
    { id: 'missing-field', metadata: { kind: 'other' } },
  ];
  const metadata = fixtures.map(fixture => ({
    ...fixture.metadata,
    profile: Object.hasOwn(fixture.metadata, 'tags') ? { tags: fixture.metadata.tags } : {},
  }));
  const allIds = fixtures.map(fixture => fixture.id);
  const cases: { name: string; filter: OracleVectorFilter; expectedIds: string[] }[] = [
    { name: 'matches no records regardless of stored field type', filter: { tags: { $all: [] } }, expectedIds: [] },
    { name: 'matches no records at a nested path', filter: { 'profile.tags': { $all: [] } }, expectedIds: [] },
    {
      name: 'matches no records when combined with AND',
      filter: { $and: [{ tags: { $all: [] } }, { kind: 'selected' }] },
      expectedIds: [],
    },
    {
      name: 'lets only the other OR branch match',
      filter: { $or: [{ tags: { $all: [] } }, { kind: 'selected' }] },
      expectedIds: ['array-both'],
    },
    {
      name: 'matches no records when OR combines two match-none filters',
      filter: { $or: [{ tags: { $all: [] } }, { tags: { $in: [] } }] },
      expectedIds: [],
    },
    { name: 'matches every record when negated', filter: { $not: { tags: { $all: [] } } }, expectedIds: allIds },
    {
      name: 'keeps nonempty all requiring every requested element',
      filter: { tags: { $all: ['oracle', 'mastra'] } },
      expectedIds: ['array-both'],
    },
    {
      name: 'preserves the current empty contains behavior',
      filter: { tags: { $contains: [] } },
      expectedIds: allIds,
    },
  ];

  let vector: OracleVector;
  let indexCreated = false;
  const indexName = `oracle_all_empty_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    vector = new OracleVector({
      id: 'oracle-vector-empty-all-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_ALL_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    await vector.createIndex({ indexName, dimension: 3, metric: 'cosine', buildIndex: false });
    indexCreated = true;
    await vector.upsert({
      indexName,
      ids: allIds,
      vectors: fixtures.map(() => [0.1, 0.2, 0.3]),
      metadata,
    });
  }, 60_000);

  afterAll(async () => {
    if (!vector) return;
    try {
      if (indexCreated) await vector.deleteIndex({ indexName });
    } finally {
      await vector.disconnect();
    }
  }, 60_000);

  describe.each(['metadata-only', 'vector-search'] as const)('%s queries', mode => {
    it.each(cases)('$name', async ({ filter, expectedIds }) => {
      const results = await vector.query({
        indexName,
        filter,
        topK: fixtures.length,
        ...(mode === 'vector-search' ? { queryVector: [0.1, 0.2, 0.3], queryMode: 'exact' as const } : {}),
      });

      expect(results.map(result => result.id).sort()).toEqual([...expectedIds].sort());
    });
  });
});

describeIntegration('OracleVector null equality compatibility', () => {
  const fixtures: { id: string; metadata: Record<string, unknown> }[] = [
    { id: 'explicit-null', metadata: { value: null } },
    { id: 'missing-field', metadata: {} },
    { id: 'empty-string', metadata: { value: '' } },
    { id: 'string-null', metadata: { value: 'null' } },
    { id: 'string-value', metadata: { value: 'present' } },
    { id: 'number-zero', metadata: { value: 0 } },
    { id: 'number-value', metadata: { value: 42 } },
    { id: 'boolean-false', metadata: { value: false } },
    { id: 'boolean-true', metadata: { value: true } },
    { id: 'array-empty', metadata: { value: [] } },
    { id: 'array-null', metadata: { value: [null] } },
    { id: 'array-string', metadata: { value: ['present'] } },
    { id: 'array-mixed-null', metadata: { value: [null, 'present'] } },
    { id: 'array-nested', metadata: { value: [[]] } },
    { id: 'object-empty', metadata: { value: {} } },
    { id: 'object-value', metadata: { value: { inner: 'present' } } },
    { id: 'object-null', metadata: { value: { inner: null } } },
    { id: 'missing-parent', metadata: {} },
    { id: 'null-parent', metadata: { profile: null } },
    { id: 'scalar-parent', metadata: { profile: 42 } },
  ];
  const metadata = fixtures.map(fixture => {
    if (fixture.id === 'missing-parent' || Object.hasOwn(fixture.metadata, 'profile')) return fixture.metadata;
    return {
      ...fixture.metadata,
      profile: Object.hasOwn(fixture.metadata, 'value') ? { value: fixture.metadata.value } : {},
    };
  });
  const allIds = fixtures.map(fixture => fixture.id);
  const missingIds = ['missing-field', 'missing-parent', 'null-parent', 'scalar-parent'];
  const nullOrMissingIds = ['explicit-null', ...missingIds];
  const nonNullIds = allIds.filter(id => !nullOrMissingIds.includes(id));
  const presentIds = allIds.filter(id => !missingIds.includes(id));

  let vector: OracleVector;
  let indexCreated = false;
  const indexName = `oracle_null_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    vector = new OracleVector({
      id: 'oracle-vector-null-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_NULL_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    await vector.createIndex({ indexName, dimension: 3, metric: 'cosine', buildIndex: false });
    indexCreated = true;
    await vector.upsert({
      indexName,
      ids: allIds,
      vectors: fixtures.map(() => [0.1, 0.2, 0.3]),
      metadata,
    });
  }, 60_000);

  afterAll(async () => {
    if (!vector) return;
    try {
      if (indexCreated) await vector.deleteIndex({ indexName });
    } finally {
      await vector.disconnect();
    }
  }, 60_000);

  describe.each(['value', 'profile.value'])('field %s', path => {
    const cases: { name: string; filter: OracleVectorFilter; expectedIds: string[] }[] = [
      {
        name: 'null equality matches only explicit JSON null or a missing field',
        filter: { [path]: { $eq: null } },
        expectedIds: nullOrMissingIds,
      },
      {
        name: 'null inequality includes arrays, objects, and empty strings but excludes null or missing',
        filter: { [path]: { $ne: null } },
        expectedIds: nonNullIds,
      },
      {
        name: 'direct null values behave like explicit equality',
        filter: { [path]: null },
        expectedIds: nullOrMissingIds,
      },
      {
        name: 'negated null equality matches present non-null fields',
        filter: { $not: { [path]: { $eq: null } } },
        expectedIds: nonNullIds,
      },
      {
        name: 'negated null inequality matches null or missing fields',
        filter: { $not: { [path]: { $ne: null } } },
        expectedIds: nullOrMissingIds,
      },
      {
        name: 'Oracle existence combined with null equality selects only explicit JSON null',
        filter: { [path]: { $eq: null, $exists: true } },
        expectedIds: ['explicit-null'],
      },
      {
        name: 'Oracle existence still includes explicit JSON null, arrays, objects, and empty strings',
        filter: { [path]: { $exists: true } },
        expectedIds: presentIds,
      },
      {
        name: 'Oracle absence still matches only missing fields',
        filter: { [path]: { $exists: false } },
        expectedIds: missingIds,
      },
    ];

    describe.each(['metadata-only', 'vector-search'] as const)('%s queries', mode => {
      it.each(cases)('$name', async ({ filter, expectedIds }) => {
        const results = await vector.query({
          indexName,
          filter,
          topK: fixtures.length,
          ...(mode === 'vector-search' ? { queryVector: [0.1, 0.2, 0.3], queryMode: 'exact' as const } : {}),
        });

        expect(results.map(result => result.id).sort()).toEqual([...expectedIds].sort());
      });
    });
  });
});

// Match ASCII fixtures with Oracle's regex engine rather than inferring behavior from SQL shape.
// The proposed flags are i (ignore case), m (multiline anchors), and s (dot matches newline).
describeIntegration('OracleVector regex matching', () => {
  const fixtures: { id: string; metadata: Record<string, unknown> }[] = [
    { id: 'lowercase', metadata: { value: 'oracle database', cohort: 'allowed' } },
    { id: 'uppercase', metadata: { value: 'ORACLE DATABASE', cohort: 'allowed' } },
    { id: 'mixed-case', metadata: { value: 'Oracle Database', cohort: 'allowed' } },
    { id: 'blocked', metadata: { value: 'oracle database', cohort: 'blocked' } },
    { id: 'surrounding-text', metadata: { value: 'before oracle database after', cohort: 'allowed' } },
    { id: 'multiline-lowercase', metadata: { value: 'before\noracle database\nafter', cohort: 'allowed' } },
    { id: 'multiline-uppercase', metadata: { value: 'before\nORACLE DATABASE\nafter', cohort: 'allowed' } },
    { id: 'newline-lowercase', metadata: { value: 'oracle\ndatabase', cohort: 'allowed' } },
    { id: 'newline-uppercase', metadata: { value: 'ORACLE\nDATABASE', cohort: 'allowed' } },
    { id: 'nonmatching', metadata: { value: 'other', cohort: 'allowed' } },
    { id: 'json-null', metadata: { value: null, cohort: 'allowed' } },
    { id: 'missing-field', metadata: { cohort: 'allowed' } },
    { id: 'array-value', metadata: { value: ['oracle database'], cohort: 'allowed' } },
    { id: 'object-value', metadata: { value: { label: 'oracle database' }, cohort: 'allowed' } },
  ];
  const metadata = fixtures.map(fixture => ({
    ...fixture.metadata,
    profile: Object.hasOwn(fixture.metadata, 'value') ? { value: fixture.metadata.value } : {},
  }));
  const caseSensitiveIds = ['lowercase', 'blocked'];
  const ignoreCaseIds = ['lowercase', 'uppercase', 'mixed-case', 'blocked'];
  const multilineIds = [...caseSensitiveIds, 'multiline-lowercase'];
  const dotAllIds = [...caseSensitiveIds, 'newline-lowercase'];
  const ignoreCaseMultilineIds = [...ignoreCaseIds, 'multiline-lowercase', 'multiline-uppercase'];
  const combinedIds = [...ignoreCaseMultilineIds, 'newline-lowercase', 'newline-uppercase'];

  let vector: OracleVector;
  let indexCreated = false;
  const indexName = `oracle_regex_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    vector = new OracleVector({
      id: 'oracle-vector-regex-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_REGEX_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    await vector.createIndex({ indexName, dimension: 3, metric: 'cosine', buildIndex: false });
    indexCreated = true;
    await vector.upsert({
      indexName,
      ids: fixtures.map(fixture => fixture.id),
      vectors: fixtures.map(() => [0.1, 0.2, 0.3]),
      metadata,
    });
  }, 60_000);

  afterAll(async () => {
    if (!vector) return;
    try {
      if (indexCreated) await vector.deleteIndex({ indexName });
    } finally {
      await vector.disconnect();
    }
  }, 60_000);

  describe.each(['value', 'profile.value'])('field %s', path => {
    const fieldFilter = (condition: unknown): OracleVectorFilter => ({ [path]: condition }) as OracleVectorFilter;
    const cases: { name: string; filter: OracleVectorFilter; expectedIds: string[] }[] = [
      {
        name: 'a direct RegExp is case-sensitive and anchors the whole value by default',
        filter: fieldFilter(/^oracle database$/),
        expectedIds: caseSensitiveIds,
      },
      {
        name: 'a string $regex has the same default matching as a direct RegExp',
        filter: fieldFilter({ $regex: '^oracle database$' }),
        expectedIds: caseSensitiveIds,
      },
      {
        name: 'empty $options preserves default matching',
        filter: fieldFilter({ $regex: '^oracle database$', $options: '' }),
        expectedIds: caseSensitiveIds,
      },
      {
        name: 'a direct RegExp honors i',
        filter: fieldFilter(/^oracle database$/i),
        expectedIds: ignoreCaseIds,
      },
      {
        name: '$options i matches the same records as a direct RegExp',
        filter: fieldFilter({ $regex: '^oracle database$', $options: 'i' }),
        expectedIds: ignoreCaseIds,
      },
      {
        name: 'a RegExp operand inside $regex preserves its pattern and flags',
        filter: fieldFilter({ $regex: /^oracle database$/i }),
        expectedIds: ignoreCaseIds,
      },
      {
        name: 'the existing leading (?i) form keeps case-insensitive matching',
        filter: fieldFilter({ $regex: '(?i)^oracle database$' }),
        expectedIds: ignoreCaseIds,
      },
      {
        name: 'a direct RegExp honors m without making dot match newline',
        filter: fieldFilter(/^oracle.*database$/m),
        expectedIds: multilineIds,
      },
      {
        name: '$options m matches the same records as a direct RegExp',
        filter: fieldFilter({ $regex: '^oracle.*database$', $options: 'm' }),
        expectedIds: multilineIds,
      },
      {
        name: 'a direct RegExp honors s without enabling multiline anchors',
        filter: fieldFilter(/^oracle.*database$/s),
        expectedIds: dotAllIds,
      },
      {
        name: '$options s matches the same records as a direct RegExp',
        filter: fieldFilter({ $regex: '^oracle.*database$', $options: 's' }),
        expectedIds: dotAllIds,
      },
      {
        name: 'a direct RegExp combines i and m',
        filter: fieldFilter(/^oracle.*database$/im),
        expectedIds: ignoreCaseMultilineIds,
      },
      {
        name: '$options im matches the same records as a direct RegExp',
        filter: fieldFilter({ $regex: '^oracle.*database$', $options: 'im' }),
        expectedIds: ignoreCaseMultilineIds,
      },
      {
        name: 'a direct RegExp combines i, m, and s',
        filter: fieldFilter(/^oracle.*database$/ims),
        expectedIds: combinedIds,
      },
      {
        name: '$options ims matches the same records as a direct RegExp',
        filter: fieldFilter({ $regex: '^oracle.*database$', $options: 'ims' }),
        expectedIds: combinedIds,
      },
      {
        name: 'regex normalization preserves a following condition on the same field',
        filter: fieldFilter({ $regex: '^oracle database$', $options: 'i', $ne: 'ORACLE DATABASE' }),
        expectedIds: ['lowercase', 'mixed-case', 'blocked'],
      },
      {
        name: 'regex normalization preserves a preceding condition on the same field',
        filter: fieldFilter({ $ne: 'ORACLE DATABASE', $regex: '^oracle database$', $options: 'i' }),
        expectedIds: ['lowercase', 'mixed-case', 'blocked'],
      },
      {
        name: 'regex normalization preserves conditions on another field',
        filter: { ...fieldFilter({ $regex: '^oracle database$', $options: 'i' }), cohort: 'allowed' },
        expectedIds: ['lowercase', 'uppercase', 'mixed-case'],
      },
      {
        name: 'regex options work inside a logical OR',
        filter: { $or: [fieldFilter({ $regex: '^oracle database$', $options: 'i' }), fieldFilter({ $eq: 'other' })] },
        expectedIds: [...ignoreCaseIds, 'nonmatching'],
      },
    ];

    describe.each(['metadata-only', 'vector-search'] as const)('%s queries', mode => {
      it.each(cases)('$name', async ({ filter, expectedIds }) => {
        const results = await vector.query({
          indexName,
          filter,
          topK: fixtures.length,
          ...(mode === 'vector-search' ? { queryVector: [0.1, 0.2, 0.3], queryMode: 'exact' as const } : {}),
        });

        // Every match fits within topK; compare membership independently of distance ordering.
        expect(results.map(result => result.id).sort()).toEqual([...expectedIds].sort());
      });
    });
  });
});

// Scalar range comparisons have an operand-type decision and a separate stored-type decision.
// Numeric operands should accept only JSON numbers, while string operands retain text extraction.
describeIntegration('OracleVector scalar range comparisons', () => {
  const fixtures: { id: string; metadata: Record<string, unknown> }[] = [
    { id: 'number-zero', metadata: { value: 0 } },
    { id: 'number-two', metadata: { value: 2 } },
    { id: 'number-ten', metadata: { value: 10 } },
    { id: 'number-twenty', metadata: { value: 20 } },
    { id: 'string-zero', metadata: { value: '0' } },
    { id: 'string-two', metadata: { value: '2' } },
    { id: 'string-ten', metadata: { value: '10' } },
    { id: 'string-twenty', metadata: { value: '20' } },
    { id: 'string-nonnumeric', metadata: { value: 'N/A' } },
    { id: 'string-empty', metadata: { value: '' } },
    { id: 'boolean-false', metadata: { value: false } },
    { id: 'boolean-true', metadata: { value: true } },
    { id: 'array-empty', metadata: { value: [] } },
    { id: 'array-number', metadata: { value: [20] } },
    { id: 'array-string', metadata: { value: ['20'] } },
    { id: 'array-mixed', metadata: { value: [2, 20, '20'] } },
    { id: 'object-empty', metadata: { value: {} } },
    { id: 'object-number', metadata: { value: { inner: 20 } } },
    { id: 'json-null', metadata: { value: null } },
    { id: 'missing-field', metadata: {} },
    { id: 'missing-parent', metadata: {} },
    { id: 'null-parent', metadata: { profile: null } },
    { id: 'scalar-parent', metadata: { profile: 20 } },
  ];
  const metadata = fixtures.map(fixture => {
    if (fixture.id === 'missing-parent' || Object.hasOwn(fixture.metadata, 'profile')) return fixture.metadata;
    return {
      ...fixture.metadata,
      profile: Object.hasOwn(fixture.metadata, 'value') ? { value: fixture.metadata.value } : {},
    };
  });
  const numericIds = ['number-zero', 'number-two', 'number-ten', 'number-twenty'];
  // Text extraction intentionally includes numeric and boolean scalars. Restricting
  // textual comparisons to stored JSON strings is a separate, unadopted change.
  const textualIds = [
    ...numericIds,
    'string-zero',
    'string-two',
    'string-ten',
    'string-twenty',
    'string-nonnumeric',
    'boolean-false',
    'boolean-true',
  ];
  const textGreaterIds = [
    'number-two',
    'number-twenty',
    'string-two',
    'string-twenty',
    'string-nonnumeric',
    'boolean-false',
    'boolean-true',
  ];
  const textEqualIds = ['number-ten', 'string-ten'];
  const textLessIds = ['number-zero', 'string-zero'];
  const ranges = [
    { operator: '$gt', numericIds: ['number-twenty'], textIds: textGreaterIds },
    { operator: '$gte', numericIds: ['number-ten', 'number-twenty'], textIds: [...textGreaterIds, ...textEqualIds] },
    { operator: '$lt', numericIds: ['number-zero', 'number-two'], textIds: textLessIds },
    {
      operator: '$lte',
      numericIds: ['number-zero', 'number-two', 'number-ten'],
      textIds: [...textLessIds, ...textEqualIds],
    },
  ] as const;

  let vector: OracleVector;
  let indexCreated = false;
  const indexName = `oracle_range_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    vector = new OracleVector({
      id: 'oracle-vector-range-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_RANGE_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    await vector.createIndex({ indexName, dimension: 3, metric: 'cosine', buildIndex: false });
    indexCreated = true;
    await vector.upsert({
      indexName,
      ids: fixtures.map(fixture => fixture.id),
      vectors: fixtures.map(() => [0.1, 0.2, 0.3]),
      metadata,
    });
  }, 60_000);

  afterAll(async () => {
    if (!vector) return;
    try {
      if (indexCreated) await vector.deleteIndex({ indexName });
    } finally {
      await vector.disconnect();
    }
  }, 60_000);

  describe.each(['value', 'profile.value'])('field %s', path => {
    const cases: { name: string; filter: OracleVectorFilter; expectedIds: string[] }[] = [];
    for (const { operator, numericIds: numericMatches, textIds: textMatches } of ranges) {
      for (const operand of [10, '10'] as const) {
        const numeric = typeof operand === 'number';
        const eligibleIds = numeric ? numericIds : textualIds;
        const matches: readonly string[] = numeric ? numericMatches : textMatches;
        const negatedIds = eligibleIds.filter(id => !matches.includes(id));
        const condition = { [operator]: operand };
        const label = `${operator} ${numeric ? 'number' : 'string'} operand ${JSON.stringify(operand)}`;

        cases.push(
          { name: `${label}: positive matching`, filter: { [path]: condition }, expectedIds: [...matches] },
          {
            name: `${label}: root NOT excludes incompatible, null, and missing values`,
            filter: { $not: { [path]: condition } },
            expectedIds: negatedIds,
          },
          {
            name: `${label}: field NOT excludes incompatible, null, and missing values`,
            filter: { [path]: { $not: condition } },
            expectedIds: negatedIds,
          },
        );
      }
    }

    describe.each(['metadata-only', 'vector-search'] as const)('%s queries', mode => {
      it.each(cases)('$name', async ({ filter, expectedIds }) => {
        const results = await vector.query({
          indexName,
          filter,
          topK: fixtures.length,
          ...(mode === 'vector-search' ? { queryVector: [0.1, 0.2, 0.3], queryMode: 'exact' as const } : {}),
        });

        // Exact membership checks catch both wrong coercion and FALSE replacing SQL NULL under NOT.
        expect(results.map(result => result.id).sort()).toEqual([...expectedIds].sort());
      });
    });
  });
});

// Nonempty array operands require stored arrays, while retaining all-elements membership.
// The type boundary yields FALSE for non-arrays, so both forms of NOT include them.
describeIntegration('OracleVector array contains boundary', () => {
  const fixtures: { id: string; metadata: Record<string, unknown> }[] = [
    { id: 'array-premium', metadata: { tags: ['premium'] } },
    { id: 'array-both', metadata: { tags: ['premium', 'vip'] } },
    { id: 'array-reversed', metadata: { tags: ['vip', 'premium'] } },
    { id: 'array-extra', metadata: { tags: ['premium', 'vip', 'other'] } },
    { id: 'array-vip', metadata: { tags: ['vip'] } },
    { id: 'array-neither', metadata: { tags: ['other'] } },
    { id: 'array-empty', metadata: { tags: [] } },
    { id: 'array-prefix', metadata: { tags: ['premium-plan'] } },
    { id: 'array-case', metadata: { tags: ['Premium'] } },
    { id: 'array-mixed', metadata: { tags: [null, 42, 'premium'] } },
    { id: 'scalar-premium', metadata: { tags: 'premium' } },
    { id: 'scalar-substring', metadata: { tags: 'Premium plan' } },
    { id: 'scalar-other', metadata: { tags: 'other' } },
    { id: 'scalar-empty', metadata: { tags: '' } },
    { id: 'object-keys', metadata: { tags: { premium: true, vip: true } } },
    { id: 'object-value', metadata: { tags: { label: 'premium' } } },
    { id: 'number', metadata: { tags: 42 } },
    { id: 'boolean-false', metadata: { tags: false } },
    { id: 'boolean-true', metadata: { tags: true } },
    { id: 'json-null', metadata: { tags: null } },
    { id: 'missing-field', metadata: {} },
    { id: 'missing-parent', metadata: {} },
    { id: 'null-parent', metadata: { profile: null } },
    { id: 'scalar-parent', metadata: { profile: 'premium' } },
  ];
  const metadata = fixtures.map(fixture => {
    if (fixture.id === 'missing-parent' || Object.hasOwn(fixture.metadata, 'profile')) return fixture.metadata;
    return {
      ...fixture.metadata,
      profile: Object.hasOwn(fixture.metadata, 'tags') ? { tags: fixture.metadata.tags } : {},
    };
  });
  const allIds = fixtures.map(fixture => fixture.id);
  const singletonIds = ['array-premium', 'array-both', 'array-reversed', 'array-extra', 'array-mixed'];
  const bothIds = ['array-both', 'array-reversed', 'array-extra'];

  let vector: OracleVector;
  let indexCreated = false;
  const indexName = `oracle_contains_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    vector = new OracleVector({
      id: 'oracle-vector-contains-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_CONTAINS_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    await vector.createIndex({ indexName, dimension: 3, metric: 'cosine', buildIndex: false });
    indexCreated = true;
    await vector.upsert({
      indexName,
      ids: allIds,
      vectors: fixtures.map(() => [0.1, 0.2, 0.3]),
      metadata,
    });
  }, 60_000);

  afterAll(async () => {
    if (!vector) return;
    try {
      if (indexCreated) await vector.deleteIndex({ indexName });
    } finally {
      await vector.disconnect();
    }
  }, 60_000);

  describe.each(['tags', 'profile.tags'])('field %s', path => {
    const fieldFilter = (condition: unknown): NonNullable<OracleVectorFilter> =>
      ({ [path]: condition }) as NonNullable<OracleVectorFilter>;
    const cases: { name: string; filter: OracleVectorFilter; expectedIds: string[] }[] = [];
    for (const { name, operand, expectedIds } of [
      { name: 'singleton', operand: ['premium'], expectedIds: singletonIds },
      { name: 'two elements', operand: ['premium', 'vip'], expectedIds: bothIds },
    ]) {
      const negatedIds = allIds.filter(id => !expectedIds.includes(id));
      cases.push(
        {
          name: `${name}: requires an actual array containing every requested element`,
          filter: fieldFilter({ $contains: operand }),
          expectedIds,
        },
        {
          name: `${name}: field NOT includes non-arrays, null, missing, and nonmatching arrays`,
          filter: fieldFilter({ $not: { $contains: operand } }),
          expectedIds: negatedIds,
        },
        {
          name: `${name}: root NOT includes non-arrays, null, missing, and nonmatching arrays`,
          filter: { $not: fieldFilter({ $contains: operand }) },
          expectedIds: negatedIds,
        },
      );
    }
    cases.push(
      {
        name: 'empty array operands still match every row including non-arrays, null, and missing',
        filter: fieldFilter({ $contains: [] }),
        expectedIds: allIds,
      },
      {
        name: 'field NOT of an empty operand still matches no rows',
        filter: fieldFilter({ $not: { $contains: [] } }),
        expectedIds: [],
      },
      {
        name: 'root NOT of an empty operand still matches no rows',
        filter: { $not: fieldFilter({ $contains: [] }) },
        expectedIds: [],
      },
      {
        name: 'string operands retain scalar substring and exact array-element matching',
        filter: fieldFilter({ $contains: 'premium' }),
        expectedIds: [...singletonIds, 'scalar-premium', 'scalar-substring'],
      },
      {
        name: 'all retains scalar wrapping and existing element membership',
        filter: fieldFilter({ $all: ['premium'] }),
        expectedIds: [...singletonIds, 'scalar-premium'],
      },
      {
        name: 'in retains scalar and array-element membership',
        filter: fieldFilter({ $in: ['premium'] }),
        expectedIds: [...singletonIds, 'scalar-premium'],
      },
      {
        name: 'nin retains array exclusion and existing scalar eligibility',
        filter: fieldFilter({ $nin: ['premium'] }),
        expectedIds: [
          'array-vip',
          'array-neither',
          'array-empty',
          'array-prefix',
          'array-case',
          'scalar-substring',
          'scalar-other',
          'number',
          'boolean-false',
          'boolean-true',
        ],
      },
    );

    describe.each(['metadata-only', 'vector-search'] as const)('%s queries', mode => {
      it.each(cases)('$name', async ({ filter, expectedIds }) => {
        const results = await vector.query({
          indexName,
          filter,
          topK: fixtures.length,
          ...(mode === 'vector-search' ? { queryVector: [0.1, 0.2, 0.3], queryMode: 'exact' as const } : {}),
        });

        // Every match fits in topK. Exact IDs verify type eligibility, path relaxation,
        // and both forms of negation independently of distance ordering.
        expect(results.map(result => result.id).sort()).toEqual([...expectedIds].sort());
      });
    });
  });
});

// Verify persisted configuration independently of the writer's cache. IVF avoids
// making these registry regressions depend on HNSW Vector Pool configuration.
describeIntegration('OracleVector registry configuration identity', () => {
  const cases = [
    { name: 'build through an uppercase fallback', operation: 'build', nameStyle: 'fallback' },
    { name: 'rebuild through an uppercase fallback', operation: 'rebuild', nameStyle: 'fallback' },
    { name: 'existing-table create through an uppercase fallback', operation: 'create', nameStyle: 'fallback' },
    { name: 'build with an exact lowercase key', operation: 'build', nameStyle: 'lowercase' },
    { name: 'build with an exact mixed-case key', operation: 'build', nameStyle: 'mixed' },
  ] as const;

  it.each(cases)(
    'persists the resolved registry identity for $name',
    async ({ operation, nameStyle }) => {
      const suffix = randomUUID().replaceAll('-', '');
      const registeredName =
        nameStyle === 'fallback'
          ? `REGISTRY_CONFIG_${suffix.toUpperCase()}`
          : nameStyle === 'mixed'
            ? `Registry_Config_${suffix}`
            : `registry_config_${suffix}`;
      const callerName = nameStyle === 'fallback' ? registeredName.toLowerCase() : registeredName;
      const registryTableName = 'ORACLE_IT_CONFIG_REGISTRY';
      const config = {
        user: process.env.ORACLE_DATABASE_USER,
        password: process.env.ORACLE_DATABASE_PASSWORD,
        connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
        tablePrefix: 'ORACLE_IT_CONFIG_VEC',
        registryTableName,
        defaultIndexConfig: { type: 'none' as const },
        defaultMetadataIndexes: [],
      };
      const writer = new OracleVector({ ...config, id: `oracle-config-writer-${suffix}` });
      const reader = new OracleVector({ ...config, id: `oracle-config-reader-${suffix}` });
      const probe = new OracleStore({
        id: `oracle-config-probe-${suffix}`,
        user: config.user,
        password: config.password,
        connectString: config.connectString,
        disableInit: true,
      });
      const indexConfig = { type: 'ivf' as const, accuracy: 87, ivf: { neighborPartitions: 1 } };
      const ids = Array.from({ length: 32 }, (_, index) => `config-vector-${index}`);
      const vectors = ids.map((_, index) => (index === 0 ? [1, 0, 0] : [(index % 5) / 7 + 0.1, (index + 1) / 33, 0.1]));

      try {
        await writer.createIndex({ indexName: registeredName, dimension: 3, metric: 'cosine', buildIndex: false });
        await writer.upsert({ indexName: registeredName, ids, vectors });
        if (operation === 'rebuild') {
          // Establish an actual pre-existing physical index with a correctly keyed write.
          await writer.buildIndex({ indexName: registeredName, indexConfig: { ...indexConfig, accuracy: 90 } });
        }
        // Warm both alias/canonical cache entries before attempting the transition.
        await expect(writer.describeIndex({ indexName: callerName })).resolves.toMatchObject({
          indexName: registeredName,
          indexType: operation === 'rebuild' ? 'ivf' : 'none',
          metric: 'cosine',
          accuracy: operation === 'rebuild' ? 90 : 95,
        });

        if (operation === 'build') {
          await writer.buildIndex({ indexName: callerName, indexConfig });
        } else if (operation === 'rebuild') {
          await writer.rebuildIndex({ indexName: callerName, metric: 'euclidean', indexConfig });
        } else {
          await writer.createIndex({ indexName: callerName, dimension: 3, metric: 'cosine', indexConfig });
        }

        const expected = {
          indexName: registeredName,
          metric: operation === 'rebuild' ? 'euclidean' : 'cosine',
          indexType: 'ivf',
          accuracy: 87,
        };
        // Inspect persisted rows directly: an alias must not create a second key or
        // leave old config hidden behind the writer's optimistic metadata cache.
        const persisted = await probe.db.execute<{
          indexName: string;
          metric: string;
          indexType: string;
          accuracy: number;
        }>(
          `SELECT index_name AS "indexName", metric AS "metric", index_type AS "indexType", accuracy AS "accuracy"
         FROM "ORACLE_IT_CONFIG_REGISTRY" WHERE index_name IN (:registeredName, :callerName)`,
          { registeredName, callerName },
        );
        expect(persisted).toEqual([expected]);
        await expect(writer.describeIndex({ indexName: callerName })).resolves.toMatchObject(expected);
        await expect(writer.describeIndex({ indexName: registeredName })).resolves.toMatchObject(expected);
        // This provider has not looked up the index before, so it cannot reuse the
        // writer's cache. Both spellings must resolve to the same persisted row.
        await expect(reader.describeIndex({ indexName: callerName })).resolves.toMatchObject({
          ...expected,
          count: 32,
        });
        await expect(reader.describeIndex({ indexName: registeredName })).resolves.toMatchObject(expected);
        await expect(
          reader.query({ indexName: callerName, queryVector: [1, 0, 0], topK: 1, queryMode: 'exact' }),
        ).resolves.toMatchObject([{ id: 'config-vector-0' }]);
      } finally {
        // Delete only the uniquely named, registered fixture, even if an assertion fails.
        try {
          await writer.deleteIndex({ indexName: registeredName });
        } finally {
          await Promise.all([writer.disconnect(), reader.disconnect(), probe.disconnect()]);
        }
      }
    },
    60_000,
  );
});

describeIntegration('OracleVector resolved-key deletion integration', () => {
  const cases = [
    { name: 'lowercase exact key', mixedCase: false, deleteUppercase: false, missingTable: false },
    { name: 'mixed-case exact key', mixedCase: true, deleteUppercase: false, missingTable: false },
    { name: 'exact key with an already-missing table', mixedCase: false, deleteUppercase: false, missingTable: true },
    { name: 'uppercase exact key', mixedCase: false, deleteUppercase: true, missingTable: false },
  ];

  it.each(cases)(
    'preserves the unrelated registry row and vectors when deleting $name',
    async testCase => {
      const suffix = randomUUID().replaceAll('-', '');
      const exactName = `${testCase.mixedCase ? 'Case_Delete' : 'case_delete'}_${suffix}`;
      const upperName = exactName.toUpperCase();
      const registryTableName = 'ORACLE_IT_CASE_DELETE_REGISTRY';
      const config = {
        user: process.env.ORACLE_DATABASE_USER,
        password: process.env.ORACLE_DATABASE_PASSWORD,
        connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
        registryTableName,
        defaultIndexConfig: { type: 'none' as const },
        defaultMetadataIndexes: [],
      };
      // Register distinct case-sensitive keys through supported public calls. The
      // separate prefixes make their physical tables distinct in one shared registry.
      const exactVector = new OracleVector({
        ...config,
        id: `case-exact-${suffix}`,
        tablePrefix: 'ORACLE_IT_CASE_EXACT',
      });
      const upperVector = new OracleVector({
        ...config,
        id: `case-upper-${suffix}`,
        tablePrefix: 'ORACLE_IT_CASE_UPPER',
      });
      const reader = new OracleVector({ ...config, id: `case-reader-${suffix}`, tablePrefix: 'ORACLE_IT_CASE_READER' });
      const probe = new OracleStore({
        id: `case-probe-${suffix}`,
        user: config.user,
        password: config.password,
        connectString: config.connectString,
        disableInit: true,
      });
      const exactTable = tableNameForIndex(exactName, 'ORACLE_IT_CASE_EXACT');
      const upperTable = tableNameForIndex(upperName, 'ORACLE_IT_CASE_UPPER');
      const created: { indexName: string; tableName: string }[] = [];
      const survivor = testCase.deleteUppercase
        ? { indexName: exactName, tableName: exactTable, id: 'exact-vector', queryVector: [1, 0, 0] }
        : { indexName: upperName, tableName: upperTable, id: 'upper-vector', queryVector: [0, 1, 0] };
      const target = testCase.deleteUppercase
        ? { vector: upperVector, indexName: upperName, tableName: upperTable }
        : { vector: exactVector, indexName: exactName, tableName: exactTable };
      const registryRows = () =>
        probe.db.execute<{ indexName: string; tableName: string }>(
          `SELECT index_name AS "indexName", table_name AS "tableName" FROM ${qualifyName(registryTableName)}
         WHERE index_name IN (:exactName, :upperName)`,
          { exactName, upperName },
        );

      try {
        await exactVector.createIndex({ indexName: exactName, dimension: 3, buildIndex: false });
        created.push({ indexName: exactName, tableName: exactTable });
        await upperVector.createIndex({ indexName: upperName, dimension: 3, buildIndex: false });
        created.push({ indexName: upperName, tableName: upperTable });
        await exactVector.upsert({ indexName: exactName, ids: ['exact-vector'], vectors: [[1, 0, 0]] });
        await upperVector.upsert({ indexName: upperName, ids: ['upper-vector'], vectors: [[0, 1, 0]] });
        expect(await registryRows()).toHaveLength(2);

        if (testCase.missingTable) {
          // This table was created by this fixture, not discovered from an arbitrary name.
          await probe.db.executeDdl(`DROP TABLE ${qualifyName(target.tableName)} PURGE`);
        }
        await target.vector.deleteIndex({ indexName: target.indexName });

        expect(await registryRows()).toEqual([{ indexName: survivor.indexName, tableName: survivor.tableName }]);
        const tables = await probe.db.execute<{ tableName: string }>(
          `SELECT table_name AS "tableName" FROM all_tables
         WHERE owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AND table_name IN (:exactTable, :upperTable)`,
          { exactTable, upperTable },
        );
        expect(tables).toEqual([{ tableName: survivor.tableName }]);
        // This reader has not cached either index. The survivor must remain usable
        // through its persisted registry entry, not merely through a writer's cache.
        await expect(reader.describeIndex({ indexName: survivor.indexName })).resolves.toMatchObject({
          indexName: survivor.indexName,
          tableName: survivor.tableName,
          count: 1,
        });
        await expect(
          reader.query({
            indexName: survivor.indexName,
            queryVector: survivor.queryVector,
            topK: 1,
            queryMode: 'exact',
          }),
        ).resolves.toMatchObject([{ id: survivor.id }]);
      } finally {
        // Do not rely on the deletion method under test to clean up. A regression
        // can orphan a table; remove only the exact UUID-owned objects we created.
        try {
          for (const entry of created.reverse()) {
            await probe.db.executeDdl(`DROP TABLE ${qualifyName(entry.tableName)} PURGE`, [-942]);
            await probe.db.none(`DELETE FROM ${qualifyName(registryTableName)} WHERE index_name = :indexName`, {
              indexName: entry.indexName,
            });
          }
        } finally {
          await Promise.all([
            exactVector.disconnect(),
            upperVector.disconnect(),
            reader.disconnect(),
            probe.disconnect(),
          ]);
        }
      }
    },
    60_000,
  );
});

// Provider-specific tests cover Oracle-only formats, shared pools, and JSON metadata behavior.
describeIntegration('OracleVector integration', () => {
  it('stores, filters, queries, updates, and deletes vectors in Oracle AI Database', async () => {
    const vector = new OracleVector({
      id: 'oracle-vector-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    const indexName = 'oracle_vector_smoke';

    try {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await vector.createIndex({
        indexName,
        dimension: 3,
        metric: 'cosine',
        buildIndex: false,
        metadataIndexes: ['resource_id', 'thread_id', 'source_id'],
      });

      await expect(
        vector.createIndex({
          indexName,
          dimension: 4,
          metric: 'cosine',
          buildIndex: false,
        }),
      ).rejects.toThrow(/dimension/i);

      await expect(
        vector.createIndex({
          indexName,
          dimension: 3,
          metric: 'euclidean',
          buildIndex: false,
        }),
      ).rejects.toThrow(/metric/i);

      const ids = await vector.upsert({
        indexName,
        ids: ['message-1', 'message-2', 'message-3'],
        vectors: [
          [0.1, 0.2, 0.3],
          [0.9, 0.1, 0.1],
          [0.1, 0.2, 0.25],
        ],
        metadata: [
          { resource_id: 'resource-1', thread_id: 'thread-1', source_id: 'doc-a', priority: 1 },
          { resource_id: 'resource-2', thread_id: 'thread-2', source_id: 'doc-b', priority: 2 },
          { resource_id: 'resource-1', thread_id: 'thread-3', source_id: 'doc-a', priority: 3 },
        ],
      });

      expect(ids).toEqual(['message-1', 'message-2', 'message-3']);

      const results = await vector.query({
        indexName,
        queryVector: [0.1, 0.2, 0.3],
        topK: 2,
        filter: { resource_id: 'resource-1' },
        includeVector: true,
      });

      expect(results).toHaveLength(2);
      expect(results[0]?.id).toBe('message-1');
      expect(results[0]?.metadata?.resource_id).toBe('resource-1');
      expect(results[0]?.vector).toHaveLength(3);

      const metadataOnly = await vector.query({
        indexName,
        topK: 5,
        filter: { source_id: 'doc-b' },
      });

      expect(metadataOnly.map(result => result.id)).toEqual(['message-2']);

      await vector.updateVector({
        indexName,
        id: 'message-2',
        update: { metadata: { resource_id: 'resource-2', thread_id: 'thread-2', source_id: 'doc-b', archived: true } },
      });

      const archived = await vector.query({
        indexName,
        topK: 1,
        filter: { archived: { $exists: true } },
      });

      expect(archived[0]?.id).toBe('message-2');

      const stats = await vector.describeIndex({ indexName });
      expect(stats).toMatchObject({ dimension: 3, count: 3, metric: 'cosine', vectorFormat: 'vector' });

      await vector.deleteVectors({ indexName, filter: { source_id: 'doc-a' } });
      const remainingStats = await vector.describeIndex({ indexName });
      expect(remainingStats.count).toBe(1);
    } finally {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await vector.disconnect();
    }
  });

  it('uses exact search by default without creating a physical vector index', async () => {
    const vector = new OracleVector({
      id: 'oracle-vector-default-none-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_DEFAULT_VEC',
    });

    const indexName = 'oracle_default_exact_search';

    try {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await vector.createIndex({
        indexName,
        dimension: 3,
        metric: 'cosine',
      });

      await vector.upsert({
        indexName,
        ids: ['exact-default-1', 'exact-default-2'],
        vectors: [
          [0.2, 0.8, 0.1],
          [0.9, 0.1, 0.2],
        ],
        metadata: [{ bucket: 'default-none' }, { bucket: 'default-none' }],
      });

      await expect(vector.describeIndex({ indexName })).resolves.toMatchObject({
        indexType: 'none',
        count: 2,
      });

      const results = await vector.query({
        indexName,
        queryVector: [0.2, 0.8, 0.1],
        topK: 1,
      });

      expect(results[0]?.id).toBe('exact-default-1');
    } finally {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await vector.disconnect();
    }
  });

  it('supports explicit IVF vector index creation while keeping exact queries available', async () => {
    const vector = new OracleVector({
      id: 'oracle-vector-ivf-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_IVF_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    const indexName = 'oracle_ivf_search';

    try {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await vector.createIndex({
        indexName,
        dimension: 3,
        metric: 'cosine',
        indexConfig: { type: 'ivf', accuracy: 90, ivf: { neighborPartitions: 1 } },
      });

      await vector.upsert({
        indexName,
        ids: ['ivf-1', 'ivf-2', 'ivf-3'],
        vectors: [
          [0.1, 0.2, 0.3],
          [0.7, 0.2, 0.1],
          [0.1, 0.25, 0.35],
        ],
        metadata: [{ kind: 'ivf' }, { kind: 'ivf' }, { kind: 'ivf' }],
      });

      await expect(vector.describeIndex({ indexName })).resolves.toMatchObject({
        indexType: 'ivf',
        metric: 'cosine',
      });

      const results = await vector.query({
        indexName,
        queryVector: [0.1, 0.2, 0.3],
        topK: 2,
        queryMode: 'exact',
      });

      expect(results.map(result => result.id)).toContain('ivf-1');
    } finally {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await vector.disconnect();
    }
  });

  it('bulk upserts at least 500 vectors in executeMany batches', async () => {
    const vector = new OracleVector({
      id: 'oracle-vector-bulk-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_BULK_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    const indexName = 'oracle_bulk_vectors';
    const ids = Array.from({ length: 500 }, (_, index) => `bulk-vector-${index}`);
    const vectors = ids.map((_, index) => [(index + 1) / 500, (500 - index) / 500, ((index % 11) + 1) / 11]);
    const metadata = ids.map((id, index) => ({ id, group: index % 5, bulk: true }));

    try {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await vector.createIndex({
        indexName,
        dimension: 3,
        metric: 'cosine',
        buildIndex: false,
      });

      await expect(vector.upsert({ indexName, ids, vectors, metadata })).resolves.toEqual(ids);

      await expect(vector.describeIndex({ indexName })).resolves.toMatchObject({ count: 500 });
      const results = await vector.query({
        indexName,
        queryVector: vectors[0]!,
        topK: 10,
        filter: { bulk: true },
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.id).toBe('bulk-vector-0');
    } finally {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await vector.disconnect();
    }
  });

  it('supports vector, bit, and int8 vector formats', async () => {
    const vector = new OracleVector({
      id: 'oracle-vector-format-integration',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_FORMAT_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    const indexes = [
      {
        indexName: 'oracle_format_vector',
        dimension: 3,
        vectorFormat: 'vector' as const,
        vectors: [[0.1, 0.2, 0.3]],
        queryVector: [0.1, 0.2, 0.3],
        metric: 'cosine' as const,
      },
      {
        indexName: 'oracle_format_bit',
        dimension: 8,
        vectorFormat: 'bit' as const,
        vectors: [[1, 0, 1, 0, 1, 0, 1, 0]],
        queryVector: [1, 0, 1, 0, 1, 0, 1, 0],
        metric: 'hamming' as const,
      },
      {
        indexName: 'oracle_format_int8',
        dimension: 4,
        vectorFormat: 'int8' as const,
        vectors: [[1, -2, 3, -4]],
        queryVector: [1, -2, 3, -4],
        metric: 'cosine' as const,
      },
    ];

    try {
      for (const index of indexes) {
        await vector.deleteIndex({ indexName: index.indexName }).catch(() => undefined);
        await vector.createIndex({
          indexName: index.indexName,
          dimension: index.dimension,
          vectorFormat: index.vectorFormat,
          metric: index.metric,
          buildIndex: false,
        });
        await vector.upsert({
          indexName: index.indexName,
          ids: [`${index.indexName}-1`],
          vectors: index.vectors,
          metadata: [{ format: index.vectorFormat }],
        });

        const results = await vector.query({
          indexName: index.indexName,
          queryVector: index.queryVector,
          topK: 1,
          includeVector: true,
        });

        expect(results[0]?.id).toBe(`${index.indexName}-1`);
        expect(results[0]?.metadata?.format).toBe(index.vectorFormat);
        expect(results[0]?.vector).toHaveLength(index.dimension);
        await expect(vector.describeIndex({ indexName: index.indexName })).resolves.toMatchObject({
          vectorFormat: index.vectorFormat,
        });
      }
    } finally {
      for (const index of indexes) {
        await vector.deleteIndex({ indexName: index.indexName }).catch(() => undefined);
      }
      await vector.disconnect();
    }
  });

  it('shares the OracleStore pool manager with vector retrieval', async () => {
    const storage = new OracleStore({
      id: 'oracle-shared-pool-storage',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      disableInit: true,
    });

    const vector = new OracleVector({
      id: 'oracle-shared-pool-vector',
      poolManager: storage.getPoolManager(),
      tablePrefix: 'ORACLE_IT_SHARED_VEC',
      defaultIndexConfig: { type: 'none' },
    });

    const indexName = 'oracle_shared_pool_smoke';

    try {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await vector.createIndex({
        indexName,
        dimension: 3,
        metric: 'cosine',
        buildIndex: false,
        metadataIndexes: ['resource_id'],
      });

      await vector.upsert({
        indexName,
        ids: ['shared-message-1'],
        vectors: [[0.1, 0.2, 0.3]],
        metadata: [{ resource_id: 'shared-resource' }],
      });

      const results = await vector.query({
        indexName,
        queryVector: [0.1, 0.2, 0.3],
        topK: 1,
        filter: { resource_id: 'shared-resource' },
      });

      expect(results[0]?.id).toBe('shared-message-1');

      const poolBeforeVectorDisconnect = await storage.getPool();
      await vector.deleteIndex({ indexName });
      await vector.disconnect();

      const poolAfterVectorDisconnect = await storage.getPool();
      expect(poolAfterVectorDisconnect).toBe(poolBeforeVectorDisconnect);

      const probe = await storage.db.execute<{ ok: number }>('SELECT 1 AS "ok" FROM dual');
      expect(probe[0]?.ok).toBe(1);
    } finally {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await vector.disconnect().catch(() => undefined);
      await storage.disconnect();
    }
  });

  it('serializes concurrent createIndex calls for the same Oracle vector index', async () => {
    const vector = new OracleVector({
      id: 'oracle-vector-concurrent-create',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_LOCK_VEC',
      defaultIndexConfig: { type: 'none' },
    });
    const indexName = 'oracle_vector_concurrent_create';

    try {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await Promise.all(
        Array.from({ length: 4 }, () =>
          vector.createIndex({
            indexName,
            dimension: 3,
            metric: 'cosine',
            buildIndex: false,
          }),
        ),
      );

      await expect(vector.describeIndex({ indexName })).resolves.toMatchObject({ dimension: 3, metric: 'cosine' });
      await expect(vector.createIndex({ indexName, dimension: 4, buildIndex: false })).rejects.toThrow(/dimension/i);
    } finally {
      await vector.deleteIndex({ indexName }).catch(() => undefined);
      await vector.disconnect();
    }
  });

  it('keeps registered vectors queryable after deleting an unknown colliding logical name', async () => {
    const suffix = randomUUID().replace(/-/g, '');
    const registeredName = `tenant-${suffix}`;
    const unknownName = `tenant_${suffix}`;
    const tablePrefix = 'ORACLE_IT_DELETE_VEC';
    expect(tableNameForIndex(unknownName, tablePrefix)).toBe(tableNameForIndex(registeredName, tablePrefix));
    const vector = new OracleVector({
      id: `oracle-vector-delete-regression-${suffix}`,
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix,
      registryTableName: 'ORACLE_IT_DELETE_REGISTRY',
      defaultIndexConfig: { type: 'none' },
      defaultMetadataIndexes: [],
    });

    try {
      await vector.createIndex({ indexName: registeredName, dimension: 3, buildIndex: false });
      await vector.upsert({
        indexName: registeredName,
        ids: ['kept-vector'],
        vectors: [[1, 0, 0]],
        metadata: [{ owner: registeredName }],
      });
      await expect(vector.query({ indexName: registeredName, queryVector: [1, 0, 0], topK: 1 })).resolves.toMatchObject(
        [{ id: 'kept-vector', metadata: { owner: registeredName } }],
      );

      await expect(vector.deleteIndex({ indexName: unknownName })).resolves.toBeUndefined();

      expect(await vector.listIndexes()).toContain(registeredName);
      const results = await vector.query({ indexName: registeredName, queryVector: [1, 0, 0], topK: 1 });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ id: 'kept-vector', metadata: { owner: registeredName } });
    } finally {
      // Clean up only our known registered index, never a guessed orphan table.
      try {
        await vector.deleteIndex({ indexName: registeredName });
      } finally {
        await vector.disconnect();
      }
    }
  });

  it('deleteIndex uses the registry table name instead of the current table prefix', async () => {
    const registryTableName = 'ORACLE_IT_DELETE_REGISTRY';
    const indexName = 'oracle_registry_delete';
    const vectorA = new OracleVector({
      id: 'oracle-vector-registry-delete-a',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_REGA_VEC',
      registryTableName,
      defaultIndexConfig: { type: 'none' },
    });
    const vectorB = new OracleVector({
      id: 'oracle-vector-registry-delete-b',
      user: process.env.ORACLE_DATABASE_USER,
      password: process.env.ORACLE_DATABASE_PASSWORD,
      connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
      tablePrefix: 'ORACLE_IT_REGB_VEC',
      registryTableName,
      defaultIndexConfig: { type: 'none' },
    });
    const tableA = tableNameForIndex(indexName, 'ORACLE_IT_REGA_VEC');

    try {
      await vectorA.deleteIndex({ indexName }).catch(() => undefined);
      await vectorB.deleteIndex({ indexName }).catch(() => undefined);
      await vectorA.createIndex({ indexName, dimension: 3, buildIndex: false });

      await vectorB.deleteIndex({ indexName });

      const probeStore = new OracleStore({
        id: 'oracle-vector-registry-delete-probe',
        user: process.env.ORACLE_DATABASE_USER,
        password: process.env.ORACLE_DATABASE_PASSWORD,
        connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
        disableInit: true,
      });
      try {
        const rows = await probeStore.db.execute<{ count: number }>(
          `SELECT COUNT(*) AS "count" FROM all_tables WHERE owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AND table_name = :tableName`,
          { tableName: tableA },
        );
        expect(Number(rows[0]?.count ?? 0)).toBe(0);
      } finally {
        await probeStore.disconnect();
      }
    } finally {
      await vectorA.deleteIndex({ indexName }).catch(() => undefined);
      await vectorB.deleteIndex({ indexName }).catch(() => undefined);
      await vectorA.disconnect();
      await vectorB.disconnect();
    }
  });

  // HNSW indexes live in Oracle's Vector Pool, sized by VECTOR_MEMORY_SIZE. The Docker container
  // in docker-compose.yaml only applies that setting after a `docker compose restart db` (see
  // scripts/configure-vector-memory.sql and the README's "Vector memory (HNSW only)" section), so
  // this suite must stay green whether or not that restart has happened. Exact search and IVF are
  // covered by the tests above and never depend on the Vector Pool.
  describe('HNSW vector index (requires Oracle Vector Pool memory)', () => {
    let hnswUnavailableReason: string | null = null;

    beforeAll(async () => {
      const probeStore = new OracleStore({
        id: 'oracle-hnsw-pool-probe',
        user: process.env.ORACLE_DATABASE_USER,
        password: process.env.ORACLE_DATABASE_PASSWORD,
        connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
        disableInit: true,
      });

      try {
        // Fast path: read the live parameter value directly. Regular app users (see the README's
        // minimum-grants section) are not granted SELECT on v$parameter, so ORA-00942 here is
        // expected and is not itself a reason to skip — it just means the test below decides
        // availability by attempting the real HNSW build instead.
        const rows = await probeStore.db.execute<{ value: string }>(
          `SELECT value AS "value" FROM v$parameter WHERE name = 'vector_memory_size'`,
        );
        const size = Number(rows[0]?.value ?? NaN);
        if (Number.isFinite(size) && size <= 0) {
          hnswUnavailableReason =
            'vector_memory_size is 0. Run `docker compose restart db` once after the container ' +
            'finishes initializing (see scripts/configure-vector-memory.sql) to enable HNSW.';
        }
      } catch {
        // v$parameter is not visible to this user; fall through to the direct build probe below.
      } finally {
        await probeStore.disconnect();
      }
    });

    it('builds an HNSW vector index once Oracle Vector Pool memory is configured', async context => {
      if (hnswUnavailableReason) {
        context.skip(hnswUnavailableReason);
      }

      const vector = new OracleVector({
        id: 'oracle-vector-hnsw-integration',
        user: process.env.ORACLE_DATABASE_USER,
        password: process.env.ORACLE_DATABASE_PASSWORD,
        connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
        tablePrefix: 'ORACLE_IT_HNSW_VEC',
        defaultIndexConfig: { type: 'none' },
      });

      const indexName = 'oracle_hnsw_search';

      try {
        await vector.deleteIndex({ indexName }).catch(() => undefined);

        try {
          await vector.createIndex({
            indexName,
            dimension: 3,
            metric: 'cosine',
            indexConfig: { type: 'hnsw' },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // ORA-51962: Vector Pool out of space — surfaces when VECTOR_MEMORY_SIZE has not taken
          // effect yet (needs a restart after scripts/configure-vector-memory.sql runs).
          if (/VECTOR_MEMORY_SIZE|Vector Pool|ORA-51962/i.test(message)) {
            context.skip(
              'Oracle Vector Pool is out of space (ORA-51962). Run `docker compose restart db` once ' +
                'after the container finishes initializing to enable HNSW.',
            );
          }
          throw error;
        }

        await vector.upsert({
          indexName,
          ids: ['hnsw-1', 'hnsw-2', 'hnsw-3'],
          vectors: [
            [0.1, 0.2, 0.3],
            [0.9, 0.1, 0.1],
            [0.1, 0.2, 0.25],
          ],
          metadata: [{ kind: 'hnsw' }, { kind: 'hnsw' }, { kind: 'hnsw' }],
        });

        await expect(vector.describeIndex({ indexName })).resolves.toMatchObject({
          indexType: 'hnsw',
          metric: 'cosine',
        });

        const results = await vector.query({
          indexName,
          queryVector: [0.1, 0.2, 0.3],
          topK: 2,
        });

        expect(results.map(result => result.id)).toContain('hnsw-1');
      } finally {
        await vector.deleteIndex({ indexName }).catch(() => undefined);
        await vector.disconnect();
      }
    });
  });
});
