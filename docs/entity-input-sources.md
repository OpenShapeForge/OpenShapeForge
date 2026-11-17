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
Resolution happens in `loadActivePlatformCompile` before contracts are cached,
so a host that calls `buildWebManifest` directly receives the same schema without
first running the all-artifact generator.

An operation may also accept an owned collection as a draft. The annotation
identifies an existing relationship; item constraints still come from the
canonical target entity. It does not grant access or execute the mutation:

```yaml
blocks:
  type: array
  x-osf-collection: { entity: DocumentVariant, field: blocks }
  items:
    x-osf-entityInput:
      entity: Block
      fields: [definitionKey, values]
```

The compiler rejects non-owned relationships and mismatched target entities.
The operation handler must execute the canonical collection mutations in its
transaction. Document creation uses this for a first variant and its blocks;
an uploaded artifact and authored content are mutually exclusive inputs.

An entity-value field can derive its typed fields from a sibling reference to
an immutable published version:

```yaml
fields:
  - key: parameters
    osfType: object
    valueFieldsFrom: { reference: version, field: parameters }
```

The source must be a stored field-definition collection on the versioned
entity. Values are validated against the selected version, with normal record
authorization; republishing the source does not change an existing block.
For an authorized version read, the definitions are returned as
`frozenFieldDefinitions.<field>` alongside the version record. A host uses
that field to present inputs for the referenced version; it is omitted when the
source record or its definitions are not readable.

The Web manifest projects the binding on the field
(`WebFieldProjection.valueFieldsFrom` in `@openshapeforge/interface-web`),
for entity fields and for the fields of `entityValueDefinitions` alike:

```ts
valueFieldsFrom?: { reference: string; field: string; headEntity?: string }
```

`reference` is the key of the sibling reference field, `field` the key of the
field-definition collection on the head entity, and `headEntity` the name of
that head entity as the compiler resolved it from the reference's version
entity — `{ reference: "version", field: "parameters", headEntity: "Template" }`
for `TemplateBlock.parameters`. The compiler sets `headEntity` on every binding
it compiles; the type keeps it optional only for manifests built before it was
projected. A client that needs to know which kind of versioned record supplies
a definition's inputs reads `headEntity`; it does not infer that from the
definition's name. The physical snapshot column is not projected.

This describes the authored-content and file-binding path, not parity for
managed document types or destructive document governance.
