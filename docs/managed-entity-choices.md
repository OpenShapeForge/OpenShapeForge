# Managed entity choices

A field can obtain its choices from the visible records of another canonical
entity instead of repeating those records in a static enum:

```yaml
- key: categoryCode
  osfType: string
  options:
    type: entity
    source: Category
    valueField: code
```

`source` is the canonical entity name. `valueField` defaults to `id`; a selected
field must exist and have the same scalar value type. Labels use the target
entity's display template, not a second label definition. The compiler rejects
unknown targets and incompatible value fields.

Operation input schemas carry `x-osf-reference: {entity, valueField}`. The Web
field projection carries `optionSource: {type: entity, source, valueField}`.
Consumers load choices through the target's authorized list Operation, including
pagination. A target that cannot be read is not an invitation to bypass its
permissions through a separate lookup endpoint.

This declaration supplies a live choice source, not referential integrity or
authorization to write the selected record. Persisted relationships still need
their database/domain invariants. No static enum is emitted, so adding a managed
record does not require rebuilding the interfaces.

## Constrained relationship choices

A persisted single relationship can narrow its canonical target list with a
small, exact predicate. For example, an inspection may select only active
facilities that belong to one configured portfolio:

```yaml
- key: facilityId
  osfType: Facility
  cardinality: single
  required: true
  persisted: { column: facility_id, storageClass: core }
  relationship:
    constraints:
      status: { eq: active }
      portfolioMemberships:
        any:
          portfolioId: { eq: "10000000-0000-4000-8000-000000000099" }
```

The language is deliberately bounded: exact scalar `eq` predicates and at
most one `hasMany.any` child predicate. There are no authored Boolean trees,
joins, scripts, or transport-specific filters. The compiler verifies every
field and relationship, then projects the same predicate into list Operation
JSON Schema, `x-osf-reference`, backend metadata, and the Web manifest.

Every write path rechecks the selected target server-side in the caller's
tenant and authorization context. A forged id therefore fails with canonical
`VALIDATION`, even when no browser is involved. If satisfying a `hasMany.any`
constraint requires creating both the target and its child membership, the
compiler also emits one discoverable core create Operation. Its two writes run
in one transaction; a child failure rolls the target creation back. Web clients
may offer creation only when that Operation is discoverable for the current
session.
