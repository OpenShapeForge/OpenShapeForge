# Managed entity choices

A field can obtain its choices from the visible records of another canonical
entity instead of repeating those records in a static enum:

```yaml
- key: categoryCode
  valueType: string
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
