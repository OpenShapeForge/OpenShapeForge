# Typed settings

OpenShapeForge settings have two owners with deliberately different powers:

- a source layer or compiler plugin defines a typed setting and its hard bounds;
- the host selects a value in committed `authoring.config.yaml`, but cannot
  widen those bounds.

The compiler loads and validates every definition before applying the host
selection. It emits one effective policy at
`apps/api/src/generated/compiler/settings-policy.json` and passes that same
value to compiler plugins as `context.settingsPolicy`. Runtime code should
consume that compiled policy, not reread YAML, environment fallbacks, or
browser input.

## Owner definitions

Definitions live below `authoring/settings/` in a committed layer or in a
plugin's shipped authoring layer. A namespace has one owner. Splitting a
namespace over multiple files from the same owner is allowed; redefining a key
or contributing to someone else's namespace is not.

```yaml
schemaVersion: 1
kind: settingsDefinition
namespace: storage.artifacts
settings:
  - key: enabled
    type: boolean
    default: false

  - key: maximumBytes
    type: integer
    default: 10000000
    minimum: 1
    maximum: 25000000

  - key: allowedMediaTypes
    type: stringSet
    default: [application/pdf]
    allowed: [application/pdf, image/png]

  - key: durability
    type: choice
    default: standard
    choices: [standard, temporary]

  - key: provider
    type: provider
    capability: artifact-storage
    allowedProviders: [filesystem]
    default: filesystem
    enabledBy: enabled
```

The types have these narrowing rules:

- `integer`: `minimum` and `maximum` are owner bounds. `default` is only the
  fallback; it is not the ceiling. A host value must be a safe integer inside
  both bounds.
- `stringSet`: `allowed` is the owner ceiling. The default and host value are
  subsets of it; the host may remove values but cannot add one.
- `choice`: the default and host selection must be one of the owner's choices.
- `boolean`: disable-only. An owner default of `true` may be narrowed to
  `false`; an owner default of `false` cannot be enabled by the host.
- `provider`: the selected provider must be in the owner's allowlist and must
  separately declare the required capability. An `enabledBy` gate names a
  boolean in the same namespace. A disabled gate yields `null`; installing or
  selecting a provider does not activate it.

Provider capabilities are also owner-authored:

```yaml
schemaVersion: 1
kind: settingsProvider
provider: filesystem
capabilities: [artifact-storage]
```

A registration is availability metadata, not activation. The provider still
has to be explicitly allowlisted by the setting owner, selected by the
effective policy, and bound by runtime composition.

## Host selection

The host uses fully qualified keys in its committed config:

```yaml
layers:
  - packages/compiler/config/authoring
plugins:
  - "@openshapeforge/plugin-artifact-storage"
settings:
  storage.artifacts.enabled: false
  storage.artifacts.maximumBytes: 5000000
  storage.artifacts.allowedMediaTypes: [application/pdf]
```

Unknown keys, wrong types, out-of-bounds values, provider mismatches, and
duplicate definitions stop compilation. `authoring.config.local.yaml` cannot
contain settings or add a layer/plugin that contains settings definitions or
providers. That file remains useful for local additive authoring, but it is not
a policy override channel.

Settings are not an authorization model. Roles, permissions, operation
controls, retention rules, credentials, endpoints, and secret values do not
belong in this contract. Those retain their canonical owners and validators.

Runtime modules read the immutable compiled projection through
`platform.settings.get(fullyQualifiedKey)` and verify selected provider
capabilities with `platform.settings.providerSupports(id, capability)`.
Missing keys remain missing: core supplies no environment or code defaults.
The runtime snapshots values at boot, rejects malformed compiled values and
provider-capability drift, and never exposes mutable compiler objects to a
module. Authoring and narrowing rules remain owned by the compiler.
