---
'@mastra/oracledb': patch
---

Fixed nonempty array-valued `$contains` filters to require stored JSON arrays containing every requested element. Matching scalar values are excluded, and negation includes non-array values, null, and missing fields. Empty operands retain their match-all behavior.
