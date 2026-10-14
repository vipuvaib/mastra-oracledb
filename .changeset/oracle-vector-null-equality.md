---
'@mastra/oracledb': patch
---

Fixed Oracle vector null comparisons incorrectly matching arrays, objects, and empty strings. Null equality matches null or missing fields, while null inequality matches present, non-null values.
