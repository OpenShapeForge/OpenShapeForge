# MCP diagnostic journal

The MCP transport can keep a short-lived diagnostic journal separately from
business audit. Configure `OPENSHAPEFORGE_MCP_DIAGNOSTICS_DIRECTORY` to a private,
persistent directory owned by the API process. With no directory, observation
is disabled. Environment identity comes from
`OPENSHAPEFORGE_DEPLOYMENT_ENVIRONMENT` or `NODE_ENV`, never client metadata.

The shared transport observer covers modern and sessionful requests, including
authentication refusals, protocol errors, HTTP-200 tool errors and task poll
results. It observes bytes already written to Node's response; it does not read
or tee another response stream. Successful writes are distinguished from an
interrupted connection. They cannot prove that a model consumed the response.
Underlying server failures are captured before the public error is masked.

Argument values, unknown input keys, results, safe request headers and raw
metadata are retained. Normalized client identifiers are indexes over that
metadata. They do not grant authority or guarantee a chat identity. Verified
server identity determines tenant and actor; failed authentication remains in
an unassigned journal, never an input-selected tenant. A stateful client's
initial self-description is carried to its later requests.

Offered tool and canonical Operation definitions and server instructions are
content-addressed snapshots. Nested definitions remain context of the external
call rather than extra user calls. Credentials, schema-marked private input,
credential-bearing headers and JSON text copies of secret fields are removed.
Ordinary personal and business context is retained. Captures have explicit byte
and depth loss markers rather than silent clipping.

Each immutable event version is an atomic, mode-0600 JSON segment in a tenant
subdirectory (mode 0700). This permits later outcomes and multiple processes to
coexist without an old acknowledgement deleting a newer result. A 32 MiB
pending-write bound drops new versions and counts that loss instead of slowing
a response behind disk I/O. Reads are bounded by event count and approximately
16 MiB per batch, while allowing one larger segment. A minute sweep removes
segments older than fourteen days and applies a 2 GiB retention target.

Reviewed runtime modules can use the public `mcpDiagnostics` capability only in
a live verified tenant session with `McpInsights.Manage`. Reading produces a
short-lived, tenant-bound receipt. Acknowledge only after ingestion has committed
in the destination database. The journal uses at-least-once delivery; consumers
must reconcile event IDs and keep terminal sent versions over older prepared
versions. Receipts are process-local and expire after ten minutes. A restart
requires recollecting the surviving segments, never deleting by a saved cursor.

Collector health is cumulative per tenant and process generation. It includes
dropped writes, failed writes and expiry before acknowledgement. It does not
measure upstream transport losses or a crash before the next health report.
Business analysis, inference, scheduling, issue creation and management belong
to the consuming feature module and are not enabled by this journal alone.
