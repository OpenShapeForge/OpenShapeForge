# Named colors

`color` stores a stable `standard:<key>` or `tenant:<key>` reference. `colorValue`
stores a concrete six-digit hex value. Standard palette definitions are immutable;
tenant definitions live in the `appearance` / `colors` TenantSetting, typed by
`colorPalette`. Its value is `{ colors: [{ key, name, value, active }] }`.

Canonical `colors.list` exposes only the public resolved palette for the verified
tenant, never other settings. Each entry has its reference, name, concrete value,
source and active flag. Existing references resolve even when archived. The shared
web context refreshes after setting events and periodically for readers who cannot
subscribe to administrative settings. Document theme resolution also reads this
palette; already materialized documents are not rewritten.

Canonical entity writes validate new references against the active tenant palette.
Palette writes and reference writes share a tenant transaction lock. Removing a
color, changing its key, or deleting its setting is refused while persisted color
columns still reference it, including entities without a published CRUD interface.
Names and values can change without changing identities. Clearing optional record
colors remains a normal null field update.

Migration 0026 converts stored literal colors to standard references where exact
values match, otherwise to named tenant colors, preserving their appearance. It
also changes document-theme defaults. Provisioning creates the empty typed setting
for new tenants. No runtime legacy-hex fallback exists.

Palette keys use the existing YAML `deriveOnCreate` rule (`from: name`,
`transform: slug`, `onConflict: suffix`). The typed-value write boundary derives
new row keys before validation, keeps persisted keys across renaming/reordering,
and refuses supplied new identities. Forms omit this server-owned input. Existing
keys are retained, including imported colors. Duplicate names receive a suffix.
