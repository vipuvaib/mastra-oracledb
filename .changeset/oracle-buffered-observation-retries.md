---
'@mastra/oracledb': patch
---

Fixed duplicate Oracle buffered observation chunks when persistence is retried for a cycle that is still buffered.