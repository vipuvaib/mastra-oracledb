---
'@mastra/oracledb': patch
---

Fixed Oracle vector regex filters to honor `i`, `m`, and `s` flags consistently for direct `RegExp` values and `$regex` patterns. Supported `$options` alongside `$regex` while preserving other filter conditions. Unsupported flags now throw an explicit error instead of being silently ignored.

For example, match case-insensitively at the start of any line:

```typescript
await vector.query({
  indexName: 'documents',
  filter: { title: { $regex: '^oracle', $options: 'im' } },
});
```
