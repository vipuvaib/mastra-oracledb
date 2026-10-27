# Oracle adapter development

This page describes the adapter's regression tests and validation commands.
Public configuration and behavior are documented in the [README](./README.md).
The [package check](./PACKAGING.md) validates installed declarations and module
resolution. [Application E2E tests](../../e2e-tests/oracledb-app/README.md) cover
HTTP behavior, persistence, recovery and delivery.

## Regression coverage

| Contract                                                      | Regression tests                                                                                                                    | Application cases |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Chronological, resource-scoped message windows                | [messages-include.test.ts](./src/storage/domains/memory/messages-include.test.ts)                                                   | A07/A08           |
| Committed observation replay, late chunks and locked counters | [observational-buffering.test.ts](./src/storage/domains/memory/observational-buffering.test.ts)                                     | D04               |
| Resource ownership and derived-memory lifecycle               | [resources.test.ts](./src/storage/domains/memory/resources.test.ts), [Memory coordination](../../packages/memory/src/index.test.ts) | D05/D06           |
| Registry-authoritative exact/uppercase deletion               | [index-delete.test.ts](./src/vector/index-delete.test.ts)                                                                           | B04/B05           |
| Canonical registry key/configuration across aliases           | [index-registry-config.test.ts](./src/vector/index-registry-config.test.ts)                                                         | B06               |
| Destructive match-all guards                                  | [index.test.ts](./src/vector/index.test.ts)                                                                                         | B08               |
| IVF probe validation and query SQL                            | [index.test.ts](./src/vector/index.test.ts), [sql.test.ts](./src/vector/sql.test.ts)                                                | Q01               |

Filter regressions cover these contracts:

| Filter                                 | Regression                                                        |
| -------------------------------------- | ----------------------------------------------------------------- |
| Stored-number scalar ranges            | [filter-range.test.ts](./src/vector/filter-range.test.ts)         |
| Exact array membership for `$contains` | [filter-contains.test.ts](./src/vector/filter-contains.test.ts)   |
| Empty `$all` matches no rows           | [filter-all-empty.test.ts](./src/vector/filter-all-empty.test.ts) |
| Array `$nin`                           | [filter.test.ts](./src/vector/filter.test.ts)                     |
| Null/missing distinctions              | [filter-null.test.ts](./src/vector/filter-null.test.ts)           |
| Array size                             | [filter-size.test.ts](./src/vector/filter-size.test.ts)           |
| Multiline/dotall regex                 | [filter-regex.test.ts](./src/vector/filter-regex.test.ts)         |

B07 checks these seven filter families against real Oracle result IDs. The focused
provider tests mock Oracle connections; passing them alone doesn't establish
real-database behavior.

## Implementation boundaries

Physical vector DDL and registry writes aren't atomic. A registry failure can leave
completed DDL; cache invalidation doesn't provide cross-instance coordination.
Regression tests check canonical keys, persisted configuration, failed commits
and alias invalidation separately.

Storage ownership transfer atomically updates the thread and its messages.
Higher-level semantic-vector migration follows that commit, so a vector failure
can leave partial state. A same-owner retry can repair vector metadata. Direct
storage deletion covers discoverable Oracle semantic vectors, not arbitrary
external indexes or every observational-memory record. See
[Memory lifecycle responsibilities](./README.md#memory-lifecycle-responsibilities)
for caller obligations.

The optional `neighborPartitionProbes` query parameter requires a positive safe
integer, an IVF index and an approximate vector query. Exact, HNSW, no-index and
metadata-only queries reject it, as does combining it with `targetAccuracy`.
Both ordinary and minimum-score SQL paths place it in the approximate-search
query block. See [query types](./src/vector/types.ts),
[query implementation](./src/vector/query.ts) and the
[public usage example](./README.md#ivf-query-search-budget).

## Run validation

Install the relevant workspace dependencies and build imported framework packages
before running adapter checks. From the repository root:

```bash
pnpm --filter @mastra/oracledb exec vitest run src/vector/index.test.ts src/vector/sql.test.ts
pnpm --filter @mastra/oracledb typecheck
pnpm --filter @mastra/oracledb lint
pnpm --filter @mastra/oracledb build:lib
pnpm --filter @mastra/oracledb test:package
```

The focused vector command covers query validation and SQL generation. Use
`pnpm --filter @mastra/oracledb test:unit` for the broader unit suite. Run unit and
integration checks before application E2E.

The package's `test:integration` lifecycle starts and removes its Docker Compose
target. The application harness instead uses an explicitly configured dedicated
schema; its setup and environment rules are in the
[E2E README](../../e2e-tests/oracledb-app/README.md#setup).

`test:package` reports Oracle-specific checks separately from the full strict
consumer. Shared dependency declaration errors still make the command fail;
see the [known validation limitation](./PACKAGING.md#known-validation-limitation).
The application harness also documents its
[Memory dependency](../../e2e-tests/oracledb-app/README.md#known-memory-dependency)
and [recorded validation status](../../e2e-tests/oracledb-app/README.md#validation-status).
