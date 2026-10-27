---
'@mastra/oracledb': minor
---

Added neighborPartitionProbes to control search breadth for approximate IVF vector queries.

Percentage targets continue to work as before:

```typescript
await vector.query({ indexName, queryVector, queryMode: 'approx', targetAccuracy: 95 });
```

To set an explicit IVF search budget, replace the percentage with the probe count:

```typescript
await vector.query({ indexName, queryVector, queryMode: 'approx', neighborPartitionProbes: 6 });
```
