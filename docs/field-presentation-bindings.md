# Value types and compound field presentation

`osfType: currency` describes an exact decimal amount. Its default input and
reading renderer is `FieldMoney`, configured in `catalogs/osf-types.yaml`.
`currency: EUR` remains a presentation/value-context setting, not the type name.
The stored semantic type remains `currency`; `FieldMoney` is its selected visual
component. This presentation change does not rename persisted definitions.

A person-name control does not require an object-valued semantic type.
`NaturalPerson` keeps `firstName`, `namePrefix` and `lastName` as ordinary
string properties stored in `first_name`, `name_prefix` and `last_name`.
Its Web view binds those properties to one Battery control:

```yaml
- id: person-name
  title: { en: Name, nl: Naam }
  render:
    component: FieldPersonName
    props:
      layout: none
      allowSingleName: false
  bindings: { givenName: firstName, prefix: namePrefix, familyName: lastName }
  fields: [firstName, namePrefix, lastName]
```

The compiler projects the binding as Web-only group metadata. Canonical
Operations, REST/MCP properties, validation and database columns stay separate.
The renderer assembles a temporary control value and distributes edits back to
the named properties. That temporary object is never a persisted field.

This first binding contract supports the name-parts presentation only. Every
source must be a readable scalar string in the same field-only group, and each
source may be bound once. The compiler rejects bindings that do not map every group field exactly once.
The consuming renderer suppresses a control with hidden runtime sources and
makes it read-only if any source cannot be written. The legacy reference host
uses the original scalar inputs, without emitting an unsupported custom renderer. Canonical Operations
remain responsible for authorization and input validation.

Battery's `allowSingleName={false}` is used for these bindings. The ordinary
component still supports single names for models that own that value contract.
This does not redesign the separate synthetic 48-field persistence fixture.

Group render accepts a component name or `{ component, props }`, as field render does. The compiler preserves these props through group overrides and the web projection; hosts must preserve them in authoring previews. Layout and component options belong to authoring. Runtime permissions and interaction state remain renderer responsibilities.
