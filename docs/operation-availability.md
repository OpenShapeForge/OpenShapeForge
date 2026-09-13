# Current record action availability

Operation authorization answers who may perform an action. Owner availability
answers whether an already authorized action is meaningful for the current
record state. An unavailable offer is not an authorization grant, reservation,
lease or proof that execution will still succeed later.

A runtime module may declare `operationAvailabilityHandlers` under the same
handler keys as its authored Operations. The compiler remains the owner of
Operation identity, rights, target, errors and interface exposure. Availability
handlers cannot register additional Operations or replace another module's
handler. Initially this seam supports authenticated, tenant-scoped record
Operations; input-dependent checks remain execution-time validation.

Each handler receives a batch of authorized target ids and a core-established
database transaction and verified session. It must be side-effect-free and
return one explicit decision per target:

```ts
{
  "record-id": {
    available: false,
    error: {
      code: "INVALID_STATE", // declared in this Operation's YAML errors
      message: "This record is already published.",
      retryable: false,
    },
  },
}
```

Core batches list/get offers by Operation after row and role checks, so a page
does not require one policy call per record. Undeclared errors, missing targets,
extra targets and malformed results fail closed. Failed metadata disables the
affected actions rather than misreporting a completed mutation as failed.
Internal exceptions are not exposed in user-facing errors.

Execution re-evaluates the same handler in the transaction used by the actual
Operation handler, before consuming mutation controls. Owner implementations
should factor existing state checks into this shared policy rather than copy
conditions into presentation code. Conditional writes and database constraints
remain necessary to serialize concurrent changes; offers do not replace them.

Web and MCP receive the same canonical `available: false` and friendly error.
Actions lacking role or record authorization are omitted instead of disclosed
as disabled. OAuth scopes are also checked before an action is offered.
