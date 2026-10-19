# Authored field presentation

Presentation options are configured in YAML. The compiler composes component
catalogue defaults, OSF-type props and field render props in that order, with
explicit field keys taking precedence (including false). Props are shallow
merged and copied; nested option objects are replaced, not recursively merged.

```yaml
# component catalogue
# defaults.string.props: { layout: above }
# OSF type props may provide shared presentation defaults.
# Entity field:
render:
  component: FieldDateAndTime
  props:
    layout: front
    showTimezoneSelector: true
    timezone: Europe/Amsterdam
    timezones: [Europe/Amsterdam, UTC]
```

The web projection forwards those props. The Battery renderer accepts the
serializable public presentation options of the chosen component; unsupported
keys are ignored. Front/above/none are field layouts, not persistence shapes.
Value, state, callbacks, authorization, record choices and loading belong to
Operations/runtime adapters, not authored visual state. Bound compound groups
continue to map UI parts to existing scalar properties.

The component catalogue lists all 48 Battery field components and authorable
props. The consuming renderer is responsible for enforcing its supported API.
A renderer can use its component's normal default when an option is absent;
application-specific presentation choices must be authored in the catalogue,
type or field. Runtime-derived formatting and semantic value conversion remain
in the adapter.

Compiled entity fields see all three authoring tiers. Runtime field definitions
only see the semantic registry and their explicit render metadata; they do not
load a host's component catalogue. Hosts without the named native component may
use a documented scalar fallback. Battery adapters retain a declarative baseline
for unprojected fields and localize it before applying authored overrides.
The catalogue validates supported props for registered native Field components.
The stored monetary type remains currency; this PR does not rename stored data.
