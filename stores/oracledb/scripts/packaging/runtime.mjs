import assert from 'node:assert/strict';
import { MastraCompositeStore } from '@mastra/core/storage';
import { MastraVector } from '@mastra/core/vector';
import { OraclePoolManager, OracleStore, OracleVector } from '@mastra/oracledb';

const config = { user: 'unused', password: 'unused', connectString: 'unused' };
const store = new OracleStore({ id: 'oracle-package-store', ...config, disableInit: true });
const vector = new OracleVector({ id: 'oracle-package-vector', ...config });
const manager = new OraclePoolManager(config);
assert.ok(store instanceof MastraCompositeStore);
assert.ok(vector instanceof MastraVector);
assert.equal(typeof manager.getPool, 'function');
assert.equal(typeof store.getStore, 'function');
assert.equal(typeof vector.query, 'function');
await store.disconnect();
await vector.disconnect();
await manager.close();
console.log('ORACLE_PACKAGED_RUNTIME_OK');
