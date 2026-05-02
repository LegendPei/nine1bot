---
name: platform.gitlab.review-finding-schema
description: Use to produce structured GitLab code review findings.
---

# Review Finding Schema

Return findings as JSON-compatible objects:

```json
{
  "title": "short finding title",
  "body": "why this matters and what should change",
  "severity": "info | minor | major | critical | blocker",
  "category": "optional stable category",
  "file": "optional repo path",
  "oldLine": 12,
  "newLine": 18,
  "source": "agent role"
}
```

Only include `file` and line fields when they are grounded in the diff manifest. Prefer no line over a guessed line.

