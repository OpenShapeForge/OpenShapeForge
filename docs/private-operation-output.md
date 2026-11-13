# Confidential Operation output

A canonical Operation may classify a JSON Schema string field with
`x-osf-classification: { sensitivity: confidential }`. This is disclosure
meaning; `x-osf-presentation: { component: FieldSecret }` remains a presentation
choice. The classifier does not grant permission to execute an Operation.

MCP discovery exposes the same canonical Operation and its private-output
interaction. The secure executor prepares a ten-minute handoff in the existing
encrypted `platform.mcp_handoffs` store. It creates no credential. The private
app displays the proposed ordinary input and submits the handoff only on the
person's click. The click supplies the canonical acknowledgement when one is declared. The app-only completion tool rechecks live availability and
contract identity and uses the same canonical dispatcher as REST. Requests are
bound to both tenant and actor; an atomic claim prevents concurrent replay.

The completion result contains declared non-confidential data in its public
envelope and confidential values only in `_meta.privateOutput`. Handler-owned
messages, follow-up Operations and resource links are not forwarded. Unexpected
handler errors are replaced by a fixed failure message. Hosts must never relay
private metadata through chat/context updates or diagnostic payloads. A trusted
MCP host still handles the private traffic; this is separation from model
context, not encryption against that host.

The shared Battery `PrivateOperation` view is composed by Hubble into its
existing MCP App resource. It reuses the shared masked result/copy renderer,
retains the values only in the mounted result, and discards them on close or a
new handoff. Other hosts must compose this renderer into their app resource to
support this interaction. A client without MCP App support is refused before
execution; there is no fallback to a model-visible secret or bearer link.

This first implementation supports explicit object properties and homogeneous
array items, up to 32 levels and 20,000 schema nodes. Confidential nodes must be
strings (optionally nullable); a collection of recovery codes classifies its
string items. Conditional schemas, references and unplaceable classifications
are refused before execution. Confidential Operations must declare idempotency
`none`: no replay receipt may retain the result. Challenge confirmations, combined secure-input/output
and asynchronous confidential results are not supported by this first slice.

If a response is lost after submission, the result is uncertain and cannot be
replayed. Inspect the integration, revoke the possibly issued credential and
issue another explicitly. The server never stores output to make it recoverable.

The primary catalog examples are integration creation and additional credential
issuance. The MCP/database test also exercises recovery codes, cross-actor and
cross-tenant refusal, concurrent submission, revocation and sanitized failures.
