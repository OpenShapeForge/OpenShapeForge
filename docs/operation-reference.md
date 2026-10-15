# Operation implementation reference

Technical and assistant guidance. Forms use the concise bilingual operation descriptions.

## Document.create

Creates a document and its first logical version together, optionally binding a staged artifact.

## DocumentVersion.create

Adds a logical version, optionally binds a staged artifact, and advances the owning document pointer atomically.

## Blueprint publication presentation

The existing `osf-blueprints.<Entity>.publish` Operation accepts optional
`thumbnail` and `retired` controls. The immutable publication snapshot stores
these under reserved `$presentation`; they are not copied entity fields.
Labels and descriptions continue to come from the configured source fields.

A thumbnail is a base64 PNG, JPEG, GIF or WebP data URI, at most 96 KiB decoded,
with a matching raster signature. External URLs, SVG and active content are
not accepted. Omitting a control preserves its previous publication setting;
`thumbnail: null` removes the image and `retired: false` restores availability.

Library list results include the published `thumbnail` when present. Lookup
selects the newest version first and excludes it when retired. Both new copies
and ordinary library listing therefore lose access to retired choices without
falling back to older versions. Existing historical versions and customer-copy
provenance remain intact. Publication permissions, source concurrency and
cross-tenant reader policies remain authoritative.
