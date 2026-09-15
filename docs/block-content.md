# Entity-backed block content

Block definitions use normal entity fields and Operations. There is no separate
block interface, inheritance hierarchy, or authored block-type registry.

## Definitions and placements

An identity-less definition (`baseEntity: false`, no `id` field) describes the
values of a placement. It does not create a standalone database table or CRUD
endpoint. Its collection-scoped Operations remain canonical Operations.

For example, the package-owned `TextBlock` definition has a `text` field with the
`multilineText` semantic type and a read-only `materialize` Operation. The normal
field compiler supplies validation, input and display metadata.

`Block` is the identity-bearing placement entity. Its `values` field selects the
definition through another field:

```yaml
- key: definitionKey
  valueType: string
  required: true
  immutable: true
  persisted: { column: definition_key, storageClass: core }
- key: values
  semanticType: entityValue
  entityValue: { definitionField: definitionKey }
  required: true
  persisted: { column: values, storageClass: core }
```

The owner selects allowed definitions on its ordinary relation field:

```yaml
- key: blocks
  semanticType: Block
  cardinality: collection
  sortable: true
  relationship: { inverse: variant, ownership: owned }
  allowedDefinitions: [TextBlock, YouTubeEmbed, TemplateBlock]
```

These fragments use the schemaVersion 3 field contract. Entity semantic types
are derived from loaded entity YAMLs, not repeated in the semantic-type catalog.

## Storage and logical fields

The compiler emits the owner foreign key, ordering column, tenant-scoped indexes
and constraints. For a mixed definition, its own values use JSONB, while its
typed entity references use definition-specific foreign-key columns on the
placement. Discriminator checks require the active definition's required
references and prohibit references for inactive definitions. References cannot
be smuggled into the own-values JSON.

The logical API field remains one object. For example, a template inclusion has
`values: { version: "<TemplateVersion UUID>", parameters: {} }`. The server splits
that shape using compiler metadata; clients never choose physical column names.
Reference authorization belongs in the same transaction as the write. Metadata
itself grants no access to the referenced records.

An entity-value carrier may explicitly enable `parameterBindings: true` beside
`definitionField`. A single relationship then accepts either a fixed UUID or
`{ parameter: "record" }`. These are alternatives, not two simultaneous targets.
The compiler retains the UUID foreign key and adds a separate parameter-name
column plus an exclusive-storage check. A symbolic name is not a database record
identity and is never stored in the UUID column or own-values JSON.

At materialization, `record` must be a declared local parameter whose inferred
entity semantic type matches the relationship target. The supplied UUID is
validated by the parameter schema and resolved through the normal authorized
entity read. Template snapshots preserve the symbolic binding; materialized
references preserve the resolved record and its version. Parameters remain
FieldDefinitions on the template version, not separately stored parameter entities.

The generated `entityValues` registry contains resolved definition fields,
JSON schemas, exact reference mappings, definition fingerprints, and owning
collection allowlists. Web receives logical field projections, not physical
storage names.

## Collection Operations

Collection changes are normal authored Operations with a built-in implementation:

```yaml
insertBlock:
  name: Add block
  description: Insert a block into the current variant.
  implementation: { type: collection, action: insert, field: blocks }
  effects: { data: write, external: none }
  reliability: { idempotency: { mode: none } }
  concurrency: { version: { mode: required, field: updatedAt } }
  confirmation: { mode: none }
```

The compiler derives the target, roles and request schema from the owning
entity, collection field and child-create contract. The request contains the
parent `id` and `expectedVersion`, plus `values` for insert or `childId` for
move. A sortable collection also accepts `beforeId`; null means the end.
Callers do not supply the inverse foreign key or stored position.

REST, MCP and Web use the same Operation and session. The built-in executor
locks the parent, checks its version, authorizes affected records and typed
references, checks cardinality, changes positions, and appends audit events in
one transaction. The collection binding is part of the Operation fingerprint.
Unsupported link/unlink or guarded-operation combinations are not offered as
working mutations.

## Template materialization

Templates have versions, and versions have explicit channel/locale variants.
Materialization selects an exact variant; it does not silently fall back to
another channel or language. Local parameters use `{{local.name}}`; shared Chip
values use `{{chips.name}}`.

The documents runtime reads authorized template, placement and Chip records,
validates values, resolves typed references through canonical read Operations,
and invokes each definition's authored read-only materialization Operation.
Template inclusion returns a typed-reference directive to the shared engine,
which controls recursion, cycles and size budgets.

The result freezes the selected source versions, parameters, Chip values,
resolved references, full compiled definitions and Operation outcomes, with a
deterministic composition hash. A preview result alone is not a persisted
DocumentVersion, a published template, or a rendered artifact.

## Current implementation boundaries

- Definition references currently support single, non-owned, unidirectional
  entity relationships. Unsupported nested or collection references fail
  compilation rather than becoming JSON IDs.
- Protected definition fields require an embedded-field policy adapter. Until
  supported, classification, authorization, permissions, operation-owned writes
  secure-input metadata and immutable value leaves fail compilation rather than
  losing their policy.
- Collection changes require atomic Operations. Generic scalar CRUD must not
  silently replace an owned collection or reassign its inverse foreign key.
- Rendering, publication and domain-specific calculations remain separate from
  the deterministic content engine. Template publication is not provider
  approval for a messaging channel.
