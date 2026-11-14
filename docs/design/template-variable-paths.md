# Template variables that follow relationships

Status: in progress (Werkbank #1801). Decided with Hans on 14 November 2026.

## What it is for

A template declares typed input parameters. A parameter can be a record
(Deal, Relation, CpqQuoteVersion, Employee, …) or a plain value. Whoever
creates the document supplies them, or the context does (a document created
from a deal gets that deal). A sales proposal is one such document; nothing
here is specific to it.

In text, and in a block field that takes a variable, an author may follow a
record parameter through its relationships to a field:

    {{local.deal.relationId.name}}
    {{local.deal.relationId.contactPersonId.firstName}}

Both the template author and the person editing the document can use them.

## Reuse, not a second path language

OSF already compiles such paths for boards and collection tables:
`compileWebValuePath` turns `a.b.c` into typed relationship steps (at most
four relationships, a scalar terminal field, cardinality one or many) and
`resolveBoardValues` reads them in authorized batches, one list request per
step. Template variables use the same rules and the same read strategy; only
the place where they run differs. Board paths are compiled in the browser
from the web manifest, a per-locale UI projection. Template variables are
resolved on the server while content is materialized, so the server gets its
own source of truth.

## Parts

1. **Entity graph in the backend manifest (compiler).** Per stored entity:
   its fields as canonical FieldDefinition projections (key, osfType,
   baseType, cardinality, reference target), its relationships (key, kind,
   target, field key, inverse, constraints) and its canonical get and list
   Operations. Generated metadata only, like `entityValues`.
2. **Path compiler (shared, pure).** `compileValuePath(graph, entity,
   expression)` with the same rules as `compileWebValuePath`, returning the
   steps and the terminal FieldDefinition. One implementation for the
   compiler, the server and the editor.
3. **Host service.** `platform.schemas.valuePaths` (absent on hosts without
   it; callers fail closed) built from the generated graph.
4. **Server resolution.** The content engine gets a `resolveVariablePath`
   resolver next to `resolveGlobalVariable`. It reads each step through the
   canonical get/list Operations under the reader's session (so record and
   field policies apply), and freezes every record it read (entity, id,
   version) plus the resolved value and its shape into the snapshot.
   A value that cannot be read is a refusal, never an empty string.
   A path with cardinality many is a list: allowed in a list/table slot,
   refused in running text unless the slot accepts many.
5. **Editor.** The `@` menu offers a record parameter's fields and lets the
   author step through its relationships (labels, not keys), inserting the
   chip with its terminal type.

## Not in scope here

Locking blocks in the editor and the Zerocopter proposal template are the
next steps of #1801 and build on this.
