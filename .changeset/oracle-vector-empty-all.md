---
'@mastra/oracledb': patch
---

Fixed Oracle vector filters with an empty `$all` list to match no records, aligning with PostgreSQL and SQLite.
