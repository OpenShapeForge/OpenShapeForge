# Read-only matrix collection views

A target entity can declare a named collection view that groups source records
by a string/entity-reference row field and pivots a string/entity-reference
column field. A numeric measure is summed across records sharing both keys.
These are presentation aggregates; no derived entity or stored amount is created.

```yaml
interfaces:
  web:
    views:
      matrix:
        kind: collection
        collectionLayout: matrix
        matrix:
          rowField: ledgerAccountId
          columnField: fiscalPeriodId
          valueField: amount
          aggregate: sum
```

The example is one additional named view alongside the existing required
`collection` view. Its referring record selects it through the ordinary
relationship placement:

```yaml
layout:
  preset: main
  tabs:
    - id: lines
      label: { en: Budget lines, nl: Begrotingsregels }
      relationship: { name: budgetLines, view: matrix }
```

`layout.preset` defaults to `inbox-main-context`; `main` selects one content
region. A main-only record does not expose the separate context/action panels.
Use it for a read-only workspace; action placement inside that layout is not
implemented by this slice.

The compiler rejects unknown, repeated, collection-valued or unreadable matrix
fields, non-string axes and a nonnumeric measure. The web projection retains
field identifiers and semantic types; it does not pick visual components.
The same mapping can describe hours by person and project.

First-slice constraints:

- Columns come from source records, not a separate period catalogue. A period
  absent from every source record is absent from the matrix. A missing
  row/column intersection stays empty; a stored zero remains zero.
- Reference labels use authorized target reads and the target display template.
  Columns are naturally sorted by their displayed labels; custom ordering and
  fiscal calendar domain expansion are not yet authored capabilities.
- All scoped pages must arrive before sums are displayed. Exact decimal sums
  retain contributing record IDs; missing measures and duplicate records fail
  visibly instead of silently undercounting or double-counting.
- No formula evaluation, mutations, comments, currency conversion or
  server-side aggregate Operation is introduced. Sums assume one unit per
  measure; do not select mixed-currency/mixed-unit data.
