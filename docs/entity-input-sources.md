# Reusing canonical fields in Operation inputs

An Operation that combines multiple entities can reference selected entity
fields instead of repeating their types, requiredness, options and validation:

```yaml
input:
  schema:
    type: object
    required: [document, version]
    additionalProperties: false
    properties:
      document:
        x-osf-entityInput:
          entity: Document
          fields: [title, documentType, status]
      version:
        x-osf-entityInput:
          entity: DocumentVersion
          fields: [versionLabel, status, changeSummary]
```

This is a compile-time reference, not a runtime validator or authority grant.
The compiler projects the selected writable create fields and implicit
relationship keys using the existing field-schema compiler and current
reference-data snapshot. Relationship inputs retain their target for record
selection. Required fields without materialized defaults remain required.

Unknown, duplicate, server-managed or operation-owned fields fail compilation.
A source node may add a title or description but cannot override constraints.
The resolved schema reaches the canonical Operation catalog and every interface;
the source keyword itself is never shipped to clients. Server-side handlers
remain responsible for their domain transaction and declared effects.

Document creation currently uses this to create a logical Document and first
DocumentVersion atomically. File upload/binding, managed document types and
destructive document governance are separate unfinished migration steps; this
does not claim their functional parity.
