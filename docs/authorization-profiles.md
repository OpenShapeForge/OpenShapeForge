# Runtime authorization profiles

Profiles are ordinary tenant-owned OSF content. The accounts module registers
validation with the existing immutable snapshot publisher. Generated entity
Operations, the existing condition AST, canonical dispatch, verified sessions,
field redaction and PostgreSQL RLS remain the execution boundaries.

## Management and application ceiling

`Organization.Security.Manage` is a separate assignable permission. A host can
include it in its existing `organizationAccess.permissions` and in chosen role
composites. Profiles cannot authorize their own management Operations. The
existing account-role Operations protect assignment of the management role;
security mutations also reuse their live authority check.

The compiler derives `authorization-operations.json` from canonical Operations,
the storage manifest and the existing tenant-assignable permission ceiling. A
manager may replace an eligible Operation's initial audience with tenant-local
users, groups or roles. Original audience membership is not the ceiling. OAuth
scopes, role groups, principal-class restrictions, record ACLs, field protection,
workflow controls and provider restrictions continue to narrow access.

A source-backed target without a generated record enforcement contract is shown
as unavailable for conditional profiles. No unsupported Service or custom target
is treated as safely enforceable merely because it has a label or an ID.

## Ordinary content and authoring

- `AuthorizationProfile` is an editable head; `active: false` withdraws it.
- Owned `AuthorizationProfilePolicy` rows name actual canonical Operation IDs.
  Insert them through `AuthorizationProfile.insertPolicy`.
- `AuthorizationProfile.publish` uses the standard snapshot publisher. Published
  `AuthorizationProfileVersion` rows cannot be edited or deleted.
- `AuthorizationProfileAssignment` pins a published version to a subject, or
  grants one Operation directly. A direct grant needs `operationId`. A profile assignment can also
  specify `operationId` to restrict the version to that one policy. Without
  an Operation scope it applies to every policy in the published version.
  A user key is an **OSF account identity ID**, not a login-provider subject.
- `AuthorizationOperationPolicy` selects application defaults or managed access
  for one Operation, and pins the reviewed list fields.

One Operation may occur in many profiles. Matching applicable profiles combine
with OR; independent boundaries combine with AND. An absent condition means all
records inside those existing boundaries. Structured conditions use the existing
canonical `rule` / `group` AST, with `resource` and `actorRelation` roots. Supported
scalar types and operators come from the compiled field metadata. Publication
rejects unknown fields, unsupported operators, incompatible constants, arbitrary
functions and unbounded expressions. The shared Web condition control renders
the same AST; it does not introduce another policy format.

`actorRelation.userId` is the verified login subject used by existing actor
fields; `relationId`, `groupIds` and `roles` come from active tenant relationships.
Person role expansion reuses the existing role-composite expander, projected for
SQL. Current membership and custom-role permissions are re-read at transaction
admission, including when the incoming session has an older flattened role set.
The caller cannot supply the actor input.

## Rollout

Unmanaged Operations retain their authored defaults. On first activation for an
entity, the existing Operation inventory is retained as explicit default states.
An unknown Operation on a managed entity is closed until reviewed. On an
unmanaged entity it retains its application defaults. The Security view identifies
unreviewed Operations.

The Security view prepares an ordinary editable profile draft of the current
role audience, previews it and publishes it before activation. An audience with
no faithful role representation requires explicit assignments. Restoring defaults
is a separate preview and confirmation. Removing all assignments or withdrawing
profiles from a managed Operation denies access without falling back to defaults.

Managed list fields start from the safe compiled display fields. A newly authored
field is not added to an existing projection. Filters and ordering cannot reveal
values outside that projection. Existing field redaction still applies.

## Enforcement and revocation

`list`, `get`, mutations and custom Operations are independent. A list grant
never supplies a get grant. A known ID can be opened under get without list.
Custom record Operations check the selected target inside their owning
transaction before effects. Mutations check both the old and resulting row;
resource triggers also cover foreign-key cascades. Existing record actions keep
their separate ability to authorize an action without read access.

A restrictive RLS policy is the database backstop. Canonical list queries also
lower supported conditions to typed SQL predicates so ordinary indexes remain
usable. Relationship traversal re-reads the parent under its own Operation, then
reads the target under its actual Operation. Authorized relationship filters use
bounded read dependencies in the existing audit/session context.

There is no cross-request profile cache. Every transaction resolves current
assignments, active profiles and immutable versions. An admitted managed command
holds a shared tenant policy lock; security changes take the corresponding
exclusive transaction lock. A committed withdrawal therefore applies to the next
admission and cannot split the check from the effect of an already admitted
command. It does not cancel effects that have already been admitted.

Conditions are bounded to 200 nodes and 16 levels, with at most 100 values per
membership operand and 2,000 characters per literal. A profile contains at most
100 distinct Operation policies. More than 100 applicable published profile
versions for one actor/Operation closes that Operation rather than truncating
its audience or restoring defaults.

## Local performance evidence

The focused scratch test exercises 20,002 Relations, eight applicable profiles
and 200 active actor group memberships. It records p50/p95 in
`/tmp/osf460-performance.json`. This measures canonical execution, database
session setup and RLS; browser/HTTP identity resolution is a separate journey.
