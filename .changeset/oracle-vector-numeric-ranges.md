---
'@mastra/oracledb': patch
---

Fixed Oracle scalar `$gt`, `$gte`, `$lt`, and `$lte` filters with number operands to compare only stored JSON numbers. Numeric strings and other non-number metadata are excluded even under negation. String operands retain textual comparison.
