# Secure entity input from an authenticated browser

An entity create Operation may declare the existing `secureInput` interaction:
a source entity carries canonical field definitions, and a server-owned target
object receives their encrypted values. This is not a general encrypted scalar.

The browser can initiate this interaction without an MCP session or tool call:

1. `POST /api/entity-configuration/start` with its ordinary bearer/session and
   JSON `{ "entity": "Example", "values": { "key": "example", "definitionId": "<uuid>" } }`.
   Supply only ordinary canonical create fields, never the secure target object.
   The response is `{ "id": "<form-id>", "expiresInSeconds": 1800 }`; it contains no handoff token.
2. `GET /api/entity-configuration/pending` with the same session returns
   `{ id, displayName, messagePrefix?, definitions }`. Render those definitions
   using the shared field registry; secret input stays in the browser form.
3. `POST /api/entity-configuration/pending/:id` with the same session and
   `application/x-www-form-urlencoded` values submits directly to encryption and
   storage. Success returns `{ "saved": true, "id": "<record-id>" }`. A failed validation returns
   `INVALID_CONFIGURATION` with bounded field errors.
4. Read the created entity through its canonical get/list Operation. Encrypted
   values appear only as `__set__`, never plaintext or ciphertext. Submitting
   again for the same stable key rotates the entered values. Omitted optional
   values retain their encrypted storage values under a row lock. Rotation checks
   the source and every supplied identity against that locked row; the same key
   cannot rebind a credential to another source or parent.

Initiation runs canonical create admission (roles, input schema, prerequisites,
confirmation) and an authorized source get before minting anything. The compiled contract determines the source entity and definition field.
Tenant IDs and actors cannot be overridden by the request. Pending forms are
scoped to the verified tenant and user; the ordinary pending endpoint cannot
read or consume another user's form. No occurrence jobs, generic expression
execution or fake connection/provider records are introduced by this interface.

Both authenticated and bearer-token form submissions claim their single-use
handoff and save its target in one database transaction. A parallel submission
loses before a write. Validation or write failure rolls back the claim and leaves
the same unexpired form retryable; success commits consumption with the write.

When an MCP client advertises App support, the server offers the private card,
but does not claim the client displayed it. If `OPENSHAPEFORGE_WEB_ORIGIN` is
configured, the tool result also includes `externalUrl` pointing to the signed-in
`/configuration?formId=<form-id>` page. This recovery link remains usable when a host drops private
App metadata or fails to display the card. It contains no handoff token: the
browser must authenticate as the same person and organization to resolve and
submit the selected pending form. The id is a correlation reference, never a
bearer credential. Both the API and client reject a different pending form, so
consumption, another chat or reloading cannot silently switch the target. Merely opening the link neither saves configuration nor
grants another identity access.
