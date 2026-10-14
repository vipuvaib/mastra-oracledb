# @mastra/oracledb

Oracle Database provider for Mastra, providing storage and vector similarity search with Oracle JSON, Oracle `VECTOR`, connection pooling, and transaction support.

## Installation

```bash
npm install @mastra/oracledb
```

## Usage

### Storage

```typescript
import { OracleStore } from '@mastra/oracledb';

const store = new OracleStore({
  id: 'oracle-store',
  user: process.env.ORACLE_DATABASE_USER,
  password: process.env.ORACLE_DATABASE_PASSWORD,
  connectString: process.env.ORACLE_DATABASE_CONNECT_STRING,
});

await store.init();
const memory = await store.getStore('memory');
if (!memory) throw new Error('Oracle memory store is not available');

// Create a thread
await memory.saveThread({
  thread: {
    id: 'thread-123',
    resourceId: 'resource-456',
    title: 'My Thread',
    metadata: { key: 'value' },
    createdAt: new Date(),
  },
});

// Add messages to thread
await memory.saveMessages({
  messages: [
    {
      id: 'msg-789',
      threadId: 'thread-123',
      role: 'user',
      content: { content: 'Hello' },
      resourceId: 'resource-456',
      createdAt: new Date(),
    },
  ],
});

// Query threads and messages
const savedThread = await memory.getThreadById({ threadId: 'thread-123' });
const { messages } = await memory.listMessages({ threadId: 'thread-123' });
```

### Memory lifecycle responsibilities

The `memory` object returned by `store.getStore('memory')` above is the low-level storage adapter,
not the higher-level `Memory` class from `@mastra/memory`. Its methods don't coordinate every
part of the memory lifecycle across storage and vector stores.

#### Resource transfer

The storage adapter's `updateThreadResourceId({ threadId, resourceId })` updates the thread and
its messages in one Oracle transaction. It doesn't update vector metadata or re-embed messages.
Direct storage callers must manage any required vector migration.

Use `Memory.updateThreadResourceId()` to coordinate storage transfer with semantic-recall message
vector migration. When a vector store, embedder, and semantic recall are configured, this method
deletes the thread's existing message vectors and re-embeds its messages under the new resource.
This doesn't migrate all derived memory, such as observational-memory records or observation vectors.

Storage transfer commits before vector migration. If migration fails, the higher-level method
throws, but the storage transfer remains committed. Retrying the higher-level method with the
same target resource retries the migration when the required vector configuration is present.
Storage and vector migration aren't one atomic transaction.

#### Thread deletion

The storage adapter's `deleteThread({ threadId })` deletes the thread, its messages, and matching
vector rows from discoverable Oracle semantic-recall tables in one transaction. Vector cleanup
uses the configured Oracle registry and recognized memory-message index names; it doesn't cover
arbitrary indexes or a separately configured vector store. The method doesn't delete thread-scoped
observational-memory records.

Use `Memory.deleteThread(threadId)` for the higher-level cleanup workflow. It clears thread-scoped
observational memory when the thread's resource ID is available and the adapter supports it, and
starts background cleanup of message and observation vectors in the configured vector store.
Call `await memory.settled()` on the higher-level `Memory` instance to wait for background cleanup
attempts before closing storage connections. Vector-cleanup failures are logged, so completion
doesn't guarantee that every vector was deleted.

If you delete threads directly through the storage adapter, capture the thread's resource ID before
deletion and explicitly call `clearObservationalMemory(threadId, resourceId)` for its thread-scoped
record. Coordinate any in-flight memory writes and additional vector cleanup yourself. Otherwise,
stale observations can survive thread-ID reuse. Don't clear shared resource-scoped observational
memory as part of deleting a single thread.

### Scalar range filters

For `$gt`, `$gte`, `$lt`, and `$lte`, number operands compare only stored JSON numbers. Numeric strings,
booleans, arrays, objects, null, and missing fields are excluded, including when the range is negated with
root or field-level `$not`.

String operands such as `"10"` use textual comparison. Scalar numbers and booleans can still participate
through Oracle's text extraction; null, missing fields, and nonscalar values are excluded. These rules
describe scalar ranges; `$elemMatch` evaluates array elements separately.

### Array contains filters

A nonempty array operand for `$contains` requires the stored field to be a JSON array containing every
requested element. For example, `{ tags: { $contains: ['premium'] } }` matches `['premium', 'vip']`, but
excludes the scalar `'premium'`. Root or field-level `$not` includes non-array values, including null and
missing fields, as well as arrays that fail the membership checks.

An empty operand (`$contains: []`) matches every row. String operands use case-insensitive scalar-substring
matching or exact array-element matching.

### Vector regex filters

Regex filters accept a direct `RegExp` or `$regex` with a string or `RegExp` pattern. String patterns can
use `$options`, for example `{ title: { $regex: '^oracle', $options: 'im' } }`. Supported flags are `i`
(ignore case), `m` (multiline anchors), and `s` (dot matches newline). Matching is case-sensitive by default.
Flags from a `RegExp` and `$options` are combined; the existing leading `(?i)` string form is also supported.
Unsupported flags and `$options` without `$regex` throw an error. Patterns use Oracle's regex syntax.

## Documentation

- [Oracle Database integration guide](https://mastra.ai/integrations/databases/oracledb)
- [Oracle Database vector reference](https://mastra.ai/reference/vectors/oracledb)

### Vector memory (HNSW only)

Exact search is the default, and IVF indexes do not require Oracle's Vector Pool. HNSW indexes do require
`VECTOR_MEMORY_SIZE` to be configured before they are built.

For the Oracle Free Docker setup, run the initialization script at the CDB root as `SYS`, then restart the
database after the container finishes initializing:

```bash
docker compose up -d --wait
docker compose restart db
```

The script is [configure-vector-memory.sql](https://github.com/mastra-ai/mastra/blob/main/stores/oracledb/scripts/configure-vector-memory.sql)
and uses `SCOPE=SPFILE`, so the restart is required. `vector.configureVectorMemory()` runs a privileged
`ALTER SYSTEM` operation on its current connection (`MEMORY` by default); it does not switch to the CDB root,
grant privileges, or restart the database. Use it only when the target Oracle deployment supports the requested
scope through that connection.

## Changelog

See the [package changelog](https://github.com/mastra-ai/mastra/blob/main/stores/oracledb/CHANGELOG.md) for version history and release notes.

## Support

We have an [open community Discord](https://discord.gg/mastra-ai). Come and say hello and let us know if you have any questions or need any help getting things running.
