# Secure entity input from an authenticated browser

An entity create Operation may declare the `secureInput` interaction: a
server-owned target object receives values a person enters in a secure form,
encrypted where their definition is confidential. This is not a general
encrypted scalar. The field definitions come from one of two places:

- **a source entity** (`sourceField`, `sourceEntity`, `definitionsField`): the
  row the new record references carries canonical field definitions, as an
  Adapter does for its Connections;
- **the Operation itself** (`fields`): the definitions are declared statically
  in the entity's YAML, and no second record is involved.

## Static secure fields

```yaml
fields:
  - { key: url, osfType: string, required: true, persisted: { column: url, storageClass: core } }
  - { key: secrets, osfType: object, persisted: { column: secret_values, storageClass: core } }
operations:
  create:
    name: Create secure endpoint
    description: Creates an endpoint after server-issued secure input.
    implementation: { type: entity, action: create }
    effects: { data: write, external: none }
    reliability: { idempotency: { mode: none } }
    confirmation: { mode: none }
    interaction:
      type: secureInput
      into: secrets
      fields:
        - key: apiKey
          osfType: string
          required: true
          label: { en: API key }
          classification: { sensitivity: confidential }
        - key: signingSecret
          osfType: string
          label: { en: Signing secret }
          classification: { sensitivity: confidential }
      resolve:
        operations: [ SecureEndpoint.send ]
        egress: { urlField: url }
  update:
    name: Update secure endpoint
    description: Updates an endpoint; its secrets are replaced through secure input.
    implementation: { type: entity, action: update }
    effects: { data: write, external: none }
    reliability: { idempotency: { mode: none } }
    concurrency: { version: { mode: required, field: updatedAt } }
    confirmation: { mode: none }
    interaction: { type: secureInput, into: secrets }
```

- `fields` are primitive definitions: `key`, `osfType` (`string`, `integer`,
  `number` or `boolean`), and optionally `required`, `label`, `description` and
  `classification.sensitivity` (`public`, `internal` or `confidential`). A
  `confidential` value is stored encrypted and read back only as `__set__`.
- `resolve` is optional. `operations` lists the canonical ids of the plugin
  Operations that may open the stored values at run time; `egress.urlField`
  names the required, persisted string field holding the one HTTPS URL those
  values may be sent to. See [plugins.md](plugins.md) for the runtime half.
  With `resolve`, at least one field must be confidential.
- `interaction: { type: secureInput, into }` on the entity's **update**
  Operation makes the stored values replaceable. It names the same target,
  declares no fields of its own, and requires version concurrency, no edit
  lease and no confirmation. An ordinary update never asks for secure input and
  can never write the target; the compiled create contract carries
  `rotation: true`.
- Values are sealed for the tenant, the table and, with `resolve`, the origin
  of the record's URL. Pointing a record at another origin does not move its
  secrets along: they must be entered again.
- The URL is an ordinary field. **Credentials belong in a header, not in the
  URL.** A URL that is not HTTPS, carries credentials or a fragment, or names a
  wildcard host is refused before the form is offered.
- The audit history hides the target column by this declaration, whatever the
  column is called.

## Creating a record

The browser initiates the interaction without an MCP session or tool call:

1. `POST /api/entity-configuration/start` with its ordinary bearer/session and
   JSON `{ "entity": "Example", "values": { ... } }`.
   Supply only ordinary canonical create fields, never the secure target object.
   The response is `{ "id": "<opaque form id>", "expiresInSeconds": 1800 }`; it contains no handoff token.
2. `GET /api/entity-configuration/pending/:id` with the returned id and same session returns
   `{ id, displayName, messagePrefix?, mode: "create", definitions }`. Each
   definition is the declared field plus `secret` (whether it is stored
   encrypted) and `schema` (its JSON Schema property): for a static form
   `{ key, osfType, required?, label?, description?, classification?, secret, schema }`.
   Render those definitions using the shared field registry; secret input
   stays in the browser form.
3. `POST /api/entity-configuration/pending/:id` with the same session and
   `application/x-www-form-urlencoded` values, one parameter per definition
   key, submits directly to encryption and storage. Success returns
   `{ "saved": true, "id": "<record id>" }`. A failed validation returns 400
   `{ "error": { "code": "INVALID_CONFIGURATION", "message", "fields": { "<key>": "<reason>" } } }`
   and leaves the form open.
4. Read the created entity through its canonical get/list Operation. Encrypted
   values appear only as `__set__`, never plaintext or ciphertext.

An ordinary create of such an entity answers `INTERACTION_REQUIRED`. For a
static form its `data.interaction` is
`{ kind: "secureInput", into, fields, rotation? }` with the declared fields, so
a client can render the secure fields from that answer alone and then run the
steps above. A source form answers with
`{ kind: "secureInput", sourceField, sourceEntity, definitionsField }`.

A create continuation never changes an existing record: submitting for a key
that already exists is refused.

## Replacing the secure values of an existing record

Only for static fields whose entity declares secure input on its update
Operation:

1. `POST /api/entity-configuration/start` with
   `{ "entity": "Example", "id": "<record id>", "expectedVersion": "<updatedAt>" }`
   and no `values`. The response is the same
   `{ "id": "<opaque form id>", "expiresInSeconds": 1800 }`.
2. `GET /api/entity-configuration/pending/:id` returns
   `{ id, displayName, mode: "rotate", recordId, definitions }`. Every
   definition has `required: false`: what is entered replaces the stored value,
   what is left empty is retained.
3. `POST /api/entity-configuration/pending/:id` with the entered values returns
   `{ "saved": true, "id": "<record id>" }`. Submitting nothing is refused with
   `INVALID_CONFIGURATION`. A record changed since `expectedVersion` is refused
   with 409 `VERSION_CONFLICT` and nothing is written; start again from the
   current version.

Initiation runs canonical update admission (update roles, record permissions,
the version control and prerequisites) and the write repeats it under the row
lock, merging into the target without touching any other field. After a change
of the record's URL origin, enter every value again.

## Guarantees

Initiation runs canonical admission (roles, input schema, prerequisites,
confirmation) and, for a source form, an authorized source get before minting
anything. The compiled contract determines the source entity and definition
field, or the static fields.
Tenant IDs and actors cannot be overridden by the request. Pending forms are
scoped to the verified tenant and user; the ordinary pending endpoint cannot
read or consume another user's form. No occurrence jobs, generic expression
execution or fake connection/provider records are introduced by this interface.

Both authenticated and bearer-token form submissions claim their single-use
handoff and save its target in one database transaction. A parallel submission
loses before a write. Validation or write failure rolls back the claim and leaves
the same unexpired form retryable; success commits consumption with the write.

MCP clients whose protocol disallows server-push elicitation, or whose
capabilities exclude form elicitation, receive the existing private MCP App
when they advertise its UI capability and the public origin is HTTPS.
Otherwise the result exposes the single-use configuration URL, as described
in `docs/mcp.md`; the entered credentials still bypass the model.
Unsupported transport errors do not
relax create admission or allow credentials as ordinary tool arguments. Other
errors (including missing encryption keys) still refuse the operation.
The latest-form `/pending` endpoint is for discovering an MCP-started form;
browser-initiated creates use their exact returned form id.
