---
'@mastra/oracledb': patch
---

Fixed Oracle message include windows to retain the requested anchor and select the correct previous and following messages when creation timestamps match. Context boundaries now use message IDs to break timestamp ties while preserving thread and resource scoping.
