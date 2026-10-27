# Oracle package validation

The package check installs local tarballs outside the workspace and validates
ESM/CommonJS resolution, public driver types and strict TypeScript consumers.
It opens no Oracle connection. For application runtime tests from installed
packages, see the [E2E package profiles](../../e2e-tests/oracledb-app/README.md#installed-packages-and-compiled-fixture).

## Public driver types

`OracleConnectionConfig`, `OraclePoolManager` and `OracleDB` expose the driver's
`Pool`, `Connection`, `PoolAttributes` and related types. The `oracledb` runtime
package doesn't provide the matching declarations, so `@types/oracledb` is a
production [dependency](./package.json). Development-only declarations wouldn't
be available to installed consumers.

The positive consumer uses the driver types supplied transitively by the Oracle
package. It doesn't install `@types/oracledb` directly or use a type shim.

## Run the check

Build the imported framework packages first, then run from the repository root:

```bash
pnpm --filter @mastra/oracledb build:lib
pnpm --filter @mastra/oracledb test:package
```

[check-package.mjs](./scripts/check-package.mjs) packs Oracle, Core and their local
Schema Compat dependency into a temporary consumer outside the checkout. Overrides
point only to those tarballs, and resolution back to workspace symlinks is rejected.

Strict NodeNext `.mts` and `.cts` fixtures inherit no repository tsconfig and use
`skipLibCheck: false`. No suppression or global driver/Zod override bypasses
consumer validation.

Positive fixtures exercise `OracleStore` and `OracleVector` against Core's
storage/vector interfaces, pool configuration, `getPool()`, `withConnection()`,
typed driver execution and `neighborPartitionProbes`. Ten negative cases cover
invalid pool values/property types, connection options, connection configuration
and query vectors in both module modes. Each requires an actual TS2322 diagnostic.

ESM/CommonJS probes check the resolved `.js`/`.cjs` paths and Oracle/Core class
compatibility. The report separates runtime, Oracle declaration, driver, consumer,
configuration and shared dependency outcomes. Any required strict errors keep the
command nonzero, even when the Oracle-specific and runtime checks pass.

## Known validation limitation

Validation recorded on 2026-10-23 passed the Oracle-specific checks: zero Oracle,
driver, consumer-source or configuration diagnostics, all ten invalid-value cases
rejected, and ESM/CommonJS runtime probes passed. **The full strict consumer failed**
on 909 shared dependency declaration diagnostics.

Those diagnostics include unresolved shared SDK symbols, provider/Zod
incompatibilities, extensionless NodeNext references and missing Schema Compat
declaration paths. Successful Oracle-specific checks don't waive the full strict
failure or require consumers to enable `skipLibCheck`.

The eight-package application consumer uses a broader import graph and records
its own [validation status](../../e2e-tests/oracledb-app/README.md#validation-status).
Results from the two graphs aren't interchangeable.

## Artifacts

Reports are written under `stores/oracledb/artifacts/packaging-<id>/` and ignored
by Git. They retain tarball hashes, command logs, the temporary consumer, complete
positive/negative diagnostics and separate check results. Use the retained report
to distinguish a public Oracle type regression from a shared dependency failure.
