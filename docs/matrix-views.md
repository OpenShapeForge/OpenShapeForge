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

# Operation matrix views

A pivot of stored records cannot show what the server computes: formulas,
group totals, a comparison with another record, or periods that have no
records yet. A named matrix view can therefore name the Operations that read
and write the whole matrix instead of the fields to pivot. The browser invokes
them by id and never evaluates a formula, a total or a comparison itself.

```yaml
interfaces:
  web:
    views:
      planning:
        kind: collection
        collectionLayout: matrix
        matrix:
          source: operation
          read: Budget.table
          apply: Budget.applyMatrix
          rows: { parentField: parentLineId }
          total: FY
          measures:
            - { key: budget, label: { en: Budget, nl: Begroting }, heading: B, format: amount, editable: true }
            - { key: lastYear, label: LY, format: amount, align: center, editable: true }
            - { key: delta, label: Δ%, heading: D, format: percentage }
          refresh: [FiscalPeriod]
```

- `read` returns rows, periods and one cell per row and period; each cell holds
  one value per measure `key`. `apply` writes rows and cells against the
  revision `read` returned. Both are qualified ids of plugin-backed Operations;
  authorization, validation and effects stay in those Operations.
- `rows.parentField` nests rows through a single field of the view's entity.
- `measures` are shown in every period, in this order. `heading` is the compact
  column heading and defaults to `label`; `align` defaults to `end`. An empty
  list shows row names only. A measure is `editable` only with an `apply`.
- `total` is the heading of a leading column group that totals all periods.
- `refresh` names further entities whose changes make the shown matrix stale;
  the view's own entity is always included.

The compiler rejects an unknown or unqualified Operation, a `read` that writes,
an `apply` that only reads, repeated measure keys, an editable measure without
`apply`, an unknown or collection-valued parent field, an unknown refresh
entity, and a view that mixes these settings with the record pivot above.

The generic record workspace renders the record pivot. An operation matrix is
a contract for a renderer that knows the shape of its `read` result: the
manifest carries the definition unchanged in meaning, with labels localized.
