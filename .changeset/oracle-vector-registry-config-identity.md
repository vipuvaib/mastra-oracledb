---
'@mastra/oracledb': patch
---

Fixed Oracle vector build, rebuild, and existing-table creation to persist configuration using the resolved registry key, including uppercase fallback matches. Reject unsuccessful registry updates and invalidate related local cached metadata instead of reporting success with stale persisted configuration.
