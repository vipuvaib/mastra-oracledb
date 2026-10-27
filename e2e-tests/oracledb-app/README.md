# Oracle application E2E

This harness tests Mastra applications with `@mastra/oracledb`. A child process
runs a loopback HTTP server, and `MastraClient` drives its public APIs with
transport retries disabled. Oracle persists messages, workflow snapshots, vectors,
scores, configuration and traces across process restarts.

The default model and embeddings are deterministic. Live-provider tests are
optional and run through a separate configuration. Application runtime checks and
strict package-consumer checks report separate outcomes.

- [Setup](#setup) and [profiles](#profiles)
- [Application cases](#application-cases)
- [Delivery and certification workloads](#delivery-and-certification-workloads)
- [Cleanup](#owned-data-lifecycle-and-cleanup) and [artifacts](#artifacts)
- [Validation status](#validation-status) and [coverage limits](#coverage-limits)

For adapter regression tests, see [Oracle development](../../stores/oracledb/DEVELOPMENT.md).
For the isolated public-driver-type check, see [package validation](../../stores/oracledb/PACKAGING.md).

## Setup

Use Node >=22.13 and the repository's pnpm version. From the repository root:

```bash
pnpm install --filter @internal/oracledb-app-e2e...
pnpm turbo build --filter @mastra/oracledb --filter @mastra/memory --filter @mastra/client-js --filter @mastra/hono --filter @mastra/observability
pnpm --filter @internal/oracledb-app-e2e typecheck
pnpm --filter @internal/oracledb-app-e2e test:harness
```

Provision an exclusive **empty** Oracle schema. Connect as its owner with
privileges to create its own tables, indexes and sequences and enough
tablespace quota. The harness does not create users or grant privileges.

Save these settings in a private file outside version control, with permissions 0600:

```dotenv
ORACLE_DATABASE_USER=MASTRA_APP_E2E
ORACLE_DATABASE_PASSWORD=your-test-schema-password
ORACLE_DATABASE_CONNECT_STRING=host:port/service
ORACLE_APP_TEST_SCHEMA=MASTRA_APP_E2E
```

Set `ORACLE_APP_TEST_ENV` to that file's absolute path. Explicit environment
variables override the file. There is no implicit fallback to the adapter or
root `.env`. The uppercase schema identifier must match the authenticated owner.

### Known Memory dependency

A07 and A08 require `@mastra/memory` to forward explicit message include windows.
Without that framework fix, agent-specific HTTP reads return no requested messages
and both cases fail. The Oracle storage path supports these windows.

Build or repack Memory after source changes so the tests use the intended runtime.

## Profiles

| Command                         | Behavior                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| test:preflight                  | Read-only owner, database-version and empty-schema checks                                |
| test:harness                    | Database-independent model, embeddings, workflow and runner checks                       |
| test:smoke                      | Seven cases: A01–A07                                                                     |
| test:e2e                        | All 33 deterministic A–F cases                                                           |
| test:certification              | The 33 application cases plus IVF/HNSW recall, relay recovery and bounded soak: 38 cases |
| test:ci                         | Typecheck and harness checks, then certification by default; smoke/e2e remain selectable |
| test:package                    | Eight local tarballs: ESM/CJS runtime and strict TypeScript checks; no Oracle connection |
| test:package:oracle             | Package checks plus the 33-case Oracle suite from installed tarballs                     |
| test:package:compiled           | The installed Oracle suite with a compiled fixture server launched by plain Node         |
| test:delivery                   | Actual CLI dev/build/start persistence journeys against an existing owned run            |
| test:upgrade                    | Published Oracle adapter 0.3.0 to current adapter, using a fresh schema                  |
| test:repeat                     | Three fresh-schema certification runs with unchanged source/build fingerprints           |
| test:restart                    | Separate manual administrative helper; requires a separately verified disposable target  |
| test:live                       | Two opt-in provider tests; refuses unset model/key settings                              |
| test:cleanup artifacts/<run-id> | Remove only the owned tables recorded by that run                                        |

After the root setup, run from the harness directory:

```bash
cd e2e-tests/oracledb-app
export ORACLE_APP_TEST_ENV=/absolute/private/oracle-app.env
pnpm test:preflight
pnpm test:ci
```

`test:ci` runs typecheck and harness checks before the 38-case certification
profile. Use `pnpm test:ci smoke` or `pnpm test:ci e2e` for a smaller deterministic
profile. Live tests aren't included or recorded as skips in those profiles.

Smoke, E2E, certification, package Oracle/compiled, upgrade and live runs need an
empty schema. Each claims its own lease. Clean the exact prior run or provision
another exclusive schema before starting a fresh-schema profile. Repeat cleans
between its first two successful runs and retains its final run. Delivery and
native restart use an explicitly supplied existing lease. Preflight is read-only;
base package and harness checks need no Oracle connection.

### Optional live provider

Set these values in the private env file before running `pnpm test:live`:

```dotenv
ORACLE_APP_LIVE_MODEL=
ORACLE_APP_LIVE_API_KEY_ENV=
```

`ORACLE_APP_LIVE_MODEL` contains a provider/model identifier.
`ORACLE_APP_LIVE_API_KEY_ENV` names the environment variable containing that
provider's key; supply its value privately. No provider or model is selected by
default. Empty settings fail before the profile claims the schema. The two cases
check generation persistence and random-code recall after restart.

### Manual CI workflow

[oracledb-app-e2e.yml](../../.github/workflows/oracledb-app-e2e.yml) requires a
self-hosted Linux runner labeled `oracle-e2e`, access to Oracle, and an `oracle-e2e`
GitHub environment with these secrets:

- `ORACLE_APP_DATABASE_USER`
- `ORACLE_APP_DATABASE_PASSWORD`
- `ORACLE_APP_DATABASE_CONNECT_STRING`
- `ORACLE_APP_TEST_SCHEMA`

Provision an empty schema before dispatch. The workflow installs and builds the
relevant packages, runs the selected deterministic CI profile, and uploads artifacts
even on failure. Runs are serialized without canceling an active run. The workflow
doesn't call a live provider or administer the database.

## Application cases

| ID  | Acceptance case                                                                         |
| --- | --------------------------------------------------------------------------------------- |
| A01 | Supported storage domains and default observability indexes                             |
| A02 | Restart with stable migration identities                                                |
| A03 | Agent generation and persisted user/assistant messages                                  |
| A04 | Complete stream and one persisted assistant response                                    |
| A05 | Calculator invocation with persisted call ID and actual result                          |
| A06 | Unique fact recalled after process restart; fresh resource has no context               |
| A07 | HTTP pagination and include windows with equal timestamps                               |
| A08 | Scoped equal-timestamp windows exclude foreign-resource anchors and neighbors           |
| B01 | Oracle vector ingestion, similarity, compound metadata filters and counts               |
| B02 | Retrieval tool returns actual documents and persists its invocation                     |
| B03 | Vector update survives restart; deleting one collection preserves another               |
| B04 | Unknown normalized-name collision cannot delete a registered collection                 |
| B05 | Exact/uppercase registry entries stay distinct during resolved-key deletion             |
| B06 | IVF build/rebuild/create through aliases preserve canonical persisted identity          |
| B07 | Scalar ranges, `$contains`, `$all`, `$nin`, null, `$size` and regex return expected IDs |
| B08 | Destructive match-all guards preserve rows; match-none mutations are harmless           |
| C01 | Suspended workflow snapshot resumes successfully in a replacement process               |
| C02 | Resource-filtered workflow listing and explicit approval rejection                      |
| C03 | Persisted workflow failure, invalid input rejection and subsequent recovery             |
| C04 | Suspended-run cancellation survives restart                                             |
| D01 | Cross-thread semantic recall into an empty target thread after restart                  |
| D02 | Resource working memory persists, enters context and stays isolated                     |
| D03 | Conversation cloning uses fresh IDs; deleting clone preserves source                    |
| D04 | Observational-memory retry, late activation, counters and scoped deletion               |
| D05 | Ownership and vector transfer, committed partial failure and same-owner repair          |
| D06 | Thread/message/vector deletion preserves sibling and unrelated resources                |
| E01 | Automatic evaluator score and observability score persist across restart                |
| E02 | Stored-agent draft configuration, versions, restart reload and deletion                 |
| E03 | Duplicate configuration IDs fail without overwriting the original                       |
| F01 | Six concurrent conversations retain unique rows and isolated context                    |
| F02 | Committed history survives abrupt application process death                             |
| F03 | Traces and spans remain queryable after process restart                                 |
| F04 | Rejected requests and repeated reconnects leave the application usable                  |

Certification adds five required cases to the 33 application cases:

| ID  | Acceptance case                                                                                    |
| --- | -------------------------------------------------------------------------------------------------- |
| Q01 | Valid IVF catalog status and mean recall@10 at least 0.90 against exact IDs                        |
| Q02 | Valid HNSW catalog status and mean recall@10 at least 0.90 against exact IDs                       |
| R01 | Bounded failure against an unavailable listener                                                    |
| R02 | Same-adapter reconnection after controlled TCP relay loss                                          |
| S01 | Four isolated conversations for thirty seconds with latency, errors, pool and consistency evidence |

Each mandatory ID must pass exactly once. Missing cases, duplicate IDs,
skips/todos, zero tests, unclean shutdown and readiness timeouts fail the runner.

The deterministic embedder uses ALPHA/BETA/GAMMA and a neutral vector. Retrieval
uses small exact-search collections; registry tests also build real IVF indexes.
Certification measures IVF and HNSW recall on a seeded corpus. D01 enables message
persistence with `lastMessages: 1`
and proves that the target thread is initially empty. Setting `lastMessages: 0`
also disables the automatic message saver and would leave vector hits without
their source message rows.

### Failure and isolation controls

The fixture's loopback-only routes call the actual Memory engine and Oracle
adapter. They expose test controls rather than production API endpoints.

D04 injects a lost acknowledgment after a real observational-memory append commits.
The actual retry must preserve one chunk/cycle. A second fixture process on the same
lease appends a real observation after activation captures its snapshot and before
the Oracle swap. Awaited loopback HTTP orders that commit without re-entering the
activation process's Memory queue. Recorded process IDs must differ. A concurrent
pending-token increment and late chunk must survive partial activation and restart.
Thread-scoped deletion must preserve another thread's observations.

D05 injects a vector migration failure after storage ownership commits. The test
requires both the HTTP failure and committed storage state, then checks that a
same-owner retry repairs vector metadata. D06 verifies complete sibling/unrelated
message and vector rows survive deletion.

B06 reads Oracle registry metadata directly because the generic index HTTP schema
returns only dimension, count and metric. B07 checks eleven ID comparisons across
seven filter families. Empty `$all` is match-none. B08 rejects eight destructive
match-all mutations with the original rows unchanged and accepts two harmless
match-none mutations. B04/B05 use valid, distinct physical collections to check
logical-name collisions and exact/uppercase registry lookup.

## Delivery and certification workloads

### Installed packages and compiled fixture

The package checker consumes prebuilt distributions for eight local packages:
Core, Memory, OracleDB, Client JS, Hono, Observability, Server and Schema Compat.
It installs tarballs outside the monorepo, overrides the selected dependencies to
those tarballs and rejects resolution back to workspace symlinks.

```bash
pnpm test:package
# Each Oracle variant requires a fresh schema:
pnpm test:package:oracle
pnpm test:package:compiled
```

The base profile checks ESM/CJS imports, generation and in-memory persistence.
Strict NodeNext `.mts` and `.cts` consumers inherit no repository tsconfig and use
`skipLibCheck: false`. Required strict errors keep the command nonzero even when
runtime checks pass. External dependencies use the normal pnpm registry/cache;
the isolated consumer sets `allowBuilds.oracledb: false` for the thin driver.

The Oracle variant runs all 33 cases with installed packages. The compiled variant
bundles the fixture with the checkout's build tool and launches it with plain Node,
resolving imports from the isolated consumer. Vitest remains the test driver.

### CLI delivery and adapter upgrade

Build the checkout's CLI from the repository root before delivery:

```bash
pnpm turbo build --filter ./packages/cli
```

From the harness directory, supply a package report as a positional argument.
Replace the placeholders with recorded IDs. Don't insert an extra `--`, which
would be interpreted as the report filename.

```bash
# Delivery uses an existing owned run:
export ORACLE_APP_RUN_ID='<existing-run-id>'
pnpm test:delivery 'artifacts/packages-<id>/report.json'
```

Delivery uses the checkout's built CLI and the eight installed application
packages. It exercises `mastra dev`, `build --studio`, `start` and a second start,
checking persistence through each transition. It doesn't test a separately packed
CLI distribution or certify Studio browser features.

```bash
# Upgrade claims a fresh empty schema:
pnpm test:upgrade 'artifacts/packages-<id>/report.json'
```

Upgrade seeds data and a suspended workflow with the published Oracle adapter
0.3.0, then reads/resumes them with the current local tarball. Other application
packages remain fixed. This tests an adapter upgrade, not a complete historical
Mastra distribution upgrade.

### IVF and HNSW recall

Q01/Q02 each build an index at accuracy 95 over 512 normalized 32-dimensional
vectors from LCG seed 104729. Twenty cosine queries compare top ten approximate
IDs against exact IDs. The minimum mean recall@10 is 0.90. Each case checks vector
catalog status/type/count, reconnects a fresh adapter and records every comparison.

IVF uses eight partitions and `neighborPartitionProbes: 6`. HNSW uses 32 neighbors,
`efConstruction: 200` and query `targetAccuracy: 95`. A fixed corpus doesn't pin
Oracle index training or partition selection. Capability or memory errors fail
the case. Certification doesn't issue `ALTER SYSTEM` or reconfigure vector memory.

### Relay recovery and bounded soak

R01 requires a closed-listener connection to fail within ten seconds using bounded
Easy Connect timeouts. R02 forwards real Oracle traffic through a private loopback
TCP relay, drops only that relay's sockets, requires an operation to fail, restores
traffic and verifies the same adapter reconnects with its lease row unchanged.
R02 requires `host:port/service` Easy Connect syntax.

S01 runs four resource-isolated conversations for thirty seconds, with at most
eight recalls each and three-second pacing. It checks every returned fact, message
count, unique ID and resource owner. Artifacts include p50/p95/p99 latency, errors,
elapsed time and sampled assertion/storage pool usage. Each pool has a maximum of
four connections. This is a bounded soak, not a production capacity test.

### Repeat certification

`pnpm test:repeat` requires three fresh-schema 38-case passes with unchanged
source/build fingerprints. It stops on the first failure, cleans only its first
two successful owned runs and retains the final run. Failed data remains available
for inspection.

### Manual native restart

`test:restart` performs an actual native Oracle shutdown/startup. It requires a
separately verified disposable instance, an existing `ORACLE_APP_RUN_ID`,
`ORACLE_APP_ARTIFACTS` pointing at the parent run, and:

- `ORACLE_APP_RESTART_DISPOSABLE=yes`
- `ORACLE_APP_RESTART_ORACLE_HOME`: Native Oracle home
- `ORACLE_APP_RESTART_SID`: Native instance SID

The helper checks the application instance name against the administrative SID.
That check alone cannot establish database identity: different databases can
share an instance name. Verify the server host, database unique name, instance,
container name/ID and container DBID against the administrative target separately
before using this helper. Run it independently of other schema tests.

The helper saves a private PFILE from the running memory configuration and uses
that snapshot for startup. It attempts recovery even after a lost shutdown
acknowledgment and retains the private configuration if startup fails. After
restart, the same adapters must reconnect with unchanged message/vector IDs,
context recall and successful workflow resume.

## Owned-data lifecycle and cleanup

A fresh run verifies schema emptiness and claims an `ORACLE_APP_E2E_RUN` marker.
Child servers verify that lease before storage initialization. Test files run
sequentially and retain data across server restarts. The harness doesn't call
`dangerouslyClearAll`.

Data remains after success or failure. Inspect its artifacts, then explicitly
clean that exact run:

```bash
pnpm test:cleanup 'artifacts/<run-id>'
```

Cleanup verifies initial emptiness, owner, lease, original table names and object
IDs. It processes parents first, rechecks each ID before dropping, skips dependents
already removed by Oracle and removes the lease last. Atomic progress bound to the
run and original manifest permits interrupted cleanup to resume only for the original
remaining identities. New or recreated objects are rejected.

Oracle can rotate HNSW auxiliary `ROWID_VID_MAP` tables after a run. A changed
identity makes cleanup refuse the old manifest. Preserve that guard and original
manifest; investigate the parent/dependent identities rather than replacing the
manifest or issuing a database-wide cleanup.

## Artifacts

Artifacts are ignored by Git. Each run records versions and fingerprints so its
results can be tied to the tested source and database configuration. Credentials
and connection strings aren't included. Temporary package consumers remain available
for inspection after success and failure.

| Location under `artifacts/`       | Contents                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `<run-id>/`                       | Revision, diff/fingerprint, Node/package/driver/database versions, logs, scenario IDs, results, report and original table manifest |
| `packages-<id>/`                  | Tarball hashes, separate runtime/type results, command logs, retained consumer and optional Oracle child results                   |
| `delivery-<id>/`                  | CLI command logs and persistence report                                                                                            |
| `upgrade-<id>/`                   | Old/new adapter logs, installation lockfile and upgrade report                                                                     |
| `<parent>/database-restart-<id>/` | Restart report and administrative logs; private PFILE excluded                                                                     |
| `repeat-<id>/`                    | Per-run counts and source/build fingerprints                                                                                       |

## Validation status

Recorded validation on 2026-10-23 used Oracle Database 26.1.0.24.0, Node 22.23.2
and Oracle driver 6.10.0. These results apply to that tested configuration.

| Check                                     | Recorded result                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| Preflight and smoke                       | Passed; smoke 7/7                                                          |
| Default CI                                | Passed typecheck, 20 harness checks and 38 certification cases, zero skips |
| Installed and compiled Oracle suites      | 33/33 runtime cases passed in each                                         |
| CLI delivery and adapter upgrade          | Passed                                                                     |
| Repeat certification                      | Three fresh runs passed 38/38 each                                         |
| Native restart                            | Passed with separate full target-identity verification                     |
| All three application package profiles    | ESM/CJS passed; **overall failed** on 1,212 shared declaration diagnostics |
| Live provider and GitHub Actions dispatch | Not executed                                                               |

The application package checks recorded zero Oracle, driver, consumer-source or
configuration diagnostics. Shared SDK, Zod and Schema Compat declaration failures
still prevent strict package-consumer certification. The smaller
[Oracle-only package check](../../stores/oracledb/PACKAGING.md#known-validation-limitation)
uses a different import graph and also retains a failed strict result. Runtime
success doesn't waive either type check.

## Coverage limits

The Oracle storage contract exposes memory, workflows, observability, scores,
agents, mcpClients and scorerDefinitions. Vectors have separate tests.

| Contract                         | Coverage                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory                           | History/windows, working/semantic/observational memory, transfer, clone and scoped deletion; agent includes require the Memory dependency above |
| Workflows                        | Suspend/resume, rejection, errors, cancellation, process/native restart and adapter upgrade                                                     |
| Observability                    | Default indexes and persisted legacy traces/spans                                                                                               |
| Scores                           | Deterministic evaluator results and persisted scored responses                                                                                  |
| Agents                           | Draft/version/reload/delete and duplicate conflicts                                                                                             |
| mcpClients and scorerDefinitions | Registration/default initialization only; runtime and CRUD aren't certified                                                                     |
| Vectors                          | Exact/filtered search, registry/filter/ownership cases, IVF/HNSW recall and recovery                                                            |
| Datasets/experiments             | Outside the adapter's seven-domain contract                                                                                                     |

Storage resource scoping isn't HTTP authentication or authorization coverage.
Small collections, a 512-vector recall corpus and a thirty-second soak don't
establish production capacity, long-duration reliability or large-scale
observational-memory reflection. Explicit buffer/activation controls aren't an
automatic scheduling benchmark. Committed-history recovery doesn't test every
in-flight crash. Other Oracle releases/deployments and complete historical Mastra
upgrades aren't certified. Batch metric creation isn't supported by this adapter.

Advanced Studio trace query/discovery isn't implemented by the Oracle observability
store. The trace page and score-to-trace link returned 501 for
`POST /observability/traces/query` and `/query/fields` during browser validation.
Legacy trace persistence tests don't certify those Studio features. Live-provider
quality remains outside deterministic test coverage.
