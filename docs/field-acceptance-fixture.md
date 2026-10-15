# The 48-field acceptance fixture

`packages/compiler/src/authoring/__fixtures__/field-acceptance/` holds one
synthetic entity, `FieldAcceptance`, whose authored top-level fields are exactly
the 48 numbered entries of the field catalogue. One entity carries every value
contract OSF can express, so the compiled contract and the typed-variable rules
can be checked against all of them at once instead of one at a time across a
hundred real entities.

## What it is, and what it is not

- **Opt-in.** It belongs to no layer in `authoring.config.yaml`. Nothing
  generates it, no migration creates its table, no deployment serves it.
- **Compiled against the real tree.** `field-acceptance-fixture.test.ts` copies
  `packages/compiler/config/authoring` into a temp directory and drops the
  fixture entity in beside it. So the semantic types it uses are the ones in
  `catalogs/osf-types.yaml`, and the entities it references — `Relation`,
  `Document`, `DocumentVersion`, `DocumentRendition`, `Address`,
  `NaturalPerson`, `ContactMoment` — are the real ones, with real foreign keys.
  A fixture-local catalogue copy would have proved nothing about the catalogue.
- **Synthetic.** No real data, no customer reference, no seeded records.
- **Not a rendered screen.** It authors `rest`, `graphql` and `mcp` and
  deliberately authors no `interfaces.web`. See [Presentation](#presentation).

## The numbered catalogue

The number is the catalogue index — the same numbering the Battery field
catalogue uses. `vars` is the authored `variables` mode: `whole` means the whole
value may be one variable, `template` means `{{…}}` tokens in its text are
replaced, `both` permits either, and a blank cell means the field accepts no
variable at all, so a `{{…}}` sequence in it is literal text. The modes follow
what `packages/operations/src/field-variables.ts` can actually honour: only a
single text value can hold a template, and only a formattable scalar can be
spliced into one.

### Text (01–08)

| # | field | osfType | vars | notes |
| --- | --- | --- | --- | --- |
| 01 | `title` | `string` | both | single-line text |
| 02 | `summary` | `multilineText` | both | |
| 03 | `body` | `markdown` | template | a formatted body is written as text with variables in it, never replaced wholesale |
| 04 | `contactEmail` | `email` | whole | type carries the pattern and the `pii` classification |
| 05 | `contactPhone` | `phone` | whole | |
| 06 | `website` | `url` | whole | |
| 07 | `reference` | `identifier` | whole | new type; pattern reaches the database as a CHECK |
| 08 | `protectedNote` | `string` | | `classification.sensitivity: confidential` + field `authorization.roles` |

**08 is not a `secret` type.** `secret` exists in OSF only for connector
configuration fields (encrypted storage, excluded from every read path);
extending it to entity fields is an implementation, not a flag. 08 therefore uses
the protected-field contract entity fields really enforce, which
`packages/operations/src/field-value-policy.ts` already honours: a caller holding
only the entity's read role never receives the value.

### Numeric and money (09–14, 35, 36)

| # | field | osfType | vars | notes |
| --- | --- | --- | --- | --- |
| 09 | `quantity` | `integer` | whole | |
| 10 | `amount` | `currency` | whole | see [Money](#money) |
| 11 | `completion` | `percentage` | whole | new type; bounds are the field's |
| 12 | `netWeight` | `measurement` | | new type; the unit travels inside the value |
| 13 | `processingTime` | `durationSeconds` | whole | new type; canonical integer seconds |
| 14 | `budgetRange` | `numericRange` | | new type; `from`/`to` |
| 35 | `payoutIban` | `iban` | whole | type carries pattern, classification, retention, audit |
| 36 | `commercialTotal` | `object` + children | | `net: currency`, `vatRate: percentage`, `gross: currency` |

**Why `measurement` is structured.** A variable-unit measurement keeps both
amount and unit inside its value. A fixed-unit field instead declares `unit:`.
Variable compatibility carries both unit and currency context and refuses a
whole-value binding between different contexts; it performs no conversion.

**36 is composition only.** Nothing recomputes `gross`. That is why it is an
authored object rather than a catalogue type that would imply an invariant the
compiler cannot enforce.

### Truth and selection (15–20, 46)

| # | field | osfType | vars | notes |
| --- | --- | --- | --- | --- |
| 15 | `isActive` | `boolean` | | required with a default, so never null |
| 16 | `isApproved` | `boolean` | | not required: null, true and false are three distinct answers |
| 17 | `category` | `string` + static options | whole | option `icon` keys and `presentation: tiles` |
| 18 | `tags` | `string` collection + static options | whole | |
| 19 | `status` | `string` + static options + `transitions` | | a declared state machine |
| 20 | `score` | `rating` | whole | new type; 1–5 bounds belong to the type |
| 46 | `accentColor` | `color` | whole | existing type; approved hex identifiers |

**19 is the only Operation in the fixture.** `approve` and `withdraw` compile to
`FieldAcceptance.approve` and `FieldAcceptance.withdraw`. No Operation was
invented to carry fixture metadata — see 43 and 47.

### Time (21–26, 48)

| # | field | osfType | vars | notes |
| --- | --- | --- | --- | --- |
| 21 | `startDate` | `date` | whole | a date never silently becomes a datetime |
| 22 | `openingTime` | `localTime` | whole | new type; no date, no zone |
| 23 | `submittedAt` | `datetime` | whole | its zone context is 48, and canonically `platform.tenants.time_zone` |
| 24 | `effectivePeriod` | `dateRange` | | new type |
| 25 | `reportingPeriod` | `calendarPeriod` | whole | new type; `2026`, `2026-H1`, `2026-Q3`, `2026-11`, `2026-W42` |
| 26 | `reviewSchedule` | `recurrence` | | stored schedule including start/end dates and explicit ending mode, see [Open gaps](#open-gaps) |
| 48 | `displayTimeZone` | `timeZone` | whole | new type; IANA zone name |

**13 is integer seconds, not ISO-8601.** `retention.duration` spells `P7Y`, but
that is a retention policy rather than a field value, and a period like `P1M`
has no fixed length in seconds. The type says its unit in its key.

**25 is not a `FiscalPeriod`.** A reporting label is a value; a `FiscalPeriod`
is a record with its own lifecycle. A domain period still references the record.

### Relationships (27–34, 38, 45)

| # | field | osfType | shape | vars |
| --- | --- | --- | --- | --- |
| 27 | `relatedRelation` | `Relation` | single reference | whole |
| 28 | `relationContactMoments` | `ContactMoment` | collection, `via: relatedRelation` | |
| 29 | `parentAcceptance` | `FieldAcceptance` | self-reference; `children` is derived | whole |
| 30 | `attachment` | `Document` | single reference | whole |
| 31 | `relationDocuments` | `Document` | collection, `via: relatedRelation` | |
| 32 | `previewRendition` | `DocumentRendition` | single reference | whole |
| 33 | `postalAddress` | `Address` | single reference | whole |
| 34 | `contactPerson` | `NaturalPerson` | single reference | whole |
| 38 | `attachmentVersions` | `DocumentVersion` | collection, `via: attachment` | |
| 45 | `location` | `coordinates` | typed object | |

**Why every collection is a traversal.** An inverse collection is *derived from
the referencing field*: `assertNoAuthoredCollections` refuses an authored entity
collection unless it is a `via` traversal. So 28, 31 and 38 are the read-only
traversal form, which is the supported authored collection contract.

**38 and ownership.** A parent-side owned-child collection field is not
authorable at all, and the fixture does not fabricate one. 38 reads the versions
of the attached document; the *ownership* is declared where OSF declares it — on
`Document`'s own `versioning` block (`versionsField: versions`,
`snapshot.ownedRelationships: recursive`) and, for a rendition, on
`DocumentRendition.sourceDocumentVersion`'s `relationship.inverse.ownership:
owned`. `childAuthorization: owner` and `childLock` are likewise declared by the
owning side; `DocumentVariant.blocks` in `entities/core/block.yaml` is the
complete worked example.

**32 is the existing image contract.** `DocumentRendition` is an immutable
derived file of one document version, with its own file name, MIME type and byte
size. No new file contract was added.

**34 does not re-model a name.** The name parts are `NaturalPerson`'s own fields.

### Structured (37, 39, 40, 44)

| # | field | osfType | vars | notes |
| --- | --- | --- | --- | --- |
| 37 | `lineGroups` | `object` collection + children | | children include `lineId: identifier` |
| 39 | `settings` | `keyValueMap` | | a map of bounded text values |
| 40 | `localizedTitle` | `string`, `localized: true` | | see below |
| 44 | `valueContract` | `fieldDefinition` | | an object with a real bundled JSON Schema |

**39 is a true keyed object.** Key uniqueness is structural: a JSON object
cannot carry the same key twice. An array of `{ key, value }` records with
`uniqueItems` would **not** give that, because two structurally different
records may carry the same `key`. `keyValueMap` requires bounded text values
and rejects prototype-related keys. Repeated groups use `validation.uniqueBy`
to enforce their own stable item identities.

**40 accepts no variable, on purpose.** `localized: true` makes the field's
*value* `{ en, nl, fr }`-shaped while its `baseType` stays `string`. A variable
slot built from that contract would describe it as plain text, which is wrong, so
the field authors no mode rather than a mode that mis-states the value.

### System and derived (41–43, 47)

| # | field | osfType | vars | notes |
| --- | --- | --- | --- | --- |
| 41 | `labels` | `labelSet` | | computed per request, not persisted |
| 42 | `eligibility` | `condition` | | the canonical expression dialect |
| 43 | `approvedAt` | `datetime` | | stamped by `approve` |
| 47 | `signedVersion` | `DocumentVersion` | | pinned; a required input of `approve` |

**41 has a real resolver.** A `labelSet` field compiles to
`computedFields: [{ field, resolver: "labelRules" }]`, which
`apps/api/src/operations/entity/computed-fields.ts` resolves per request from
`label_rules`. Each label's result type is the `LabelRule` record's own
`outputType` (the `labelOutputType` catalogue entry: boolean, number or string).

**42 is a formula in an explicit dialect, and nothing eval's it.** `condition`
holds a canonical expression — the same contract `LabelRule.expression` uses —
evaluated by the generated `apps/api/src/generated/compiler/expression-evaluator.ts`,
whose operators are declared up front (`add`/`sub`/`mul`/`div`/`mod`, `concat`,
`lower`/`upper`/`substring`/`matches`, `if`, `coalesce`, `aggregate`, date
helpers) and which bounds its own regex inputs. No string is executed.

**43 and 47 add no Operation.** The state machine 19 already justifies is the
only writer: `approve` stamps `approvedAt` with the transaction time and requires
`signedVersion`. Both are absent from the generated create and update schemas on
every transport, and a caller sending either is refused by name. This is the
shape `Document.currentVersionId` and `DocumentVersion.documentId` already use.

**47 simulates no signature.** OSF has no signature artifact of its own. 47 is a
pinned reference to the immutable `DocumentVersion` that carries the evidence, so
what is recorded is *which immutable version was signed*, by the Operation that
checked the preconditions. `signedVersion` does not also author
`immutable: true`, because a transition write on an already-immutable field is
refused; `writtenBy` already keeps it out of generic create and update.

## Money

`currency` keeps `baseType: number` as its **logical** type.
`packages/operations/src/scalar-projection.ts` stores a PostgreSQL `numeric` and
returns exact decimal text, so no amount passes through a float and no
cents-integer migration is needed.

`decimalPlaces` and `scale` (`units` | `thousands` | `millions`) are **display**
metadata on the catalogue entry's `props`, read by the shared money formatter.
They restate the formatter's own defaults and change neither storage nor
arithmetic: a presentation in millions still stores units.

The catalogue supplies defaults. Stored FieldDefinitions may set the same
properties on `render.props`; the field editor exposes them through its explicit
`moneyDisplay` profile control. Core entity fields retain their schema-3 data
contract, while a Web view's field entry can override presentation per view:

```yaml
- key: amount
  render:
    component: MoneyInput
    props:
      decimalPlaces: 0
      scale: millions
```

The compiler validates decimal places as an integer from 0 to 20 and scale as
one of the three declared choices. The host projection retains the properties.
The shared exact formatter rounds presentation only; edits and canonical writes
keep the unscaled value. Authored numeric bounds may use exact decimal text,
including bounds beyond JavaScript's safe integer range.

## Presentation

The fixture authors **no `interfaces.web`**. An entity's web presentation is
designed from the user's tasks against inspected Battery components and Figma
patterns (see the repository's authoring instructions); Battery is not a
dependency of this tree, so a grouped view authored from here would be a claim
about controls nobody checked. The seven task groups above are the intended
grouping, and authoring them is a separate increment once the presentation is
designed.

**Battery coverage.** Battery is not a dependency of this repository, so nothing
here is verified from its source. At Battery 0.0.62, 24 of the 48 field controls
exist — `FieldMoney`, `FieldPercentage`, `FieldMeasurement`, `FieldNumericRange`,
`FieldDateRange`, the integer and decimal fields and the duration field among
them — and the other 24 do not. That boundary is the design system's, not this fixture's: compiling a
value contract is not the same thing as having a control for it, and this
document claims only the former. Nothing here is a fallback renderer presented
as a finished field.

Numeric and date ranges enforce ordered endpoints at canonical and dynamic API
validation boundaries. Time zones are checked against the runtime IANA database.
Money display supports decimal places and units, thousands or millions; both
properties are declared by the money and number component contracts.

## Open gaps

Each is a capability the authoring contract does not have. The fixture authors
the nearest supported contract and says so rather than implying the missing one.

| gap | affects | status |
| --- | --- | --- |
| nothing expands a `recurrence` | 26 | the type is a value contract; no scheduler for it exists |

## Running it

```
bun test packages/compiler/src/authoring/field-acceptance-fixture.test.ts
```

The test compiles the fixture twice and asserts the two results are identical
(determinism), that exactly 48 fields are authored and that they correspond
one-to-one with the numbered catalogue, that the base meta-fields and the derived
`children` collection are present *and* excluded from that count, the compiled
value contract of each field (type axis, children of each typed object, real
bounds, the rendered CHECKs, the storage column types), the authored variable
mode, and the compatibility refusals — money against an arbitrary number, a
percentage against a currency, a reference against a bare uuid or another
entity's reference, a scalar against a collection, a date against a datetime, a
narrowed option domain against an undeclared one, a template where none is
permitted, and an object written into text.


### Recurrence value persistence

The recurrence contract retains the native field's `start` and `end` calendar
dates, `endCondition` (`never`, `onDate`, `afterCount`) and bounded `count`
(1–1000), alongside frequency, interval, dayOfMonth and occurrences. `onDate`
requires an end date; `afterCount` requires count. When both dates are present and the ending is on-date (explicitly or inferred),
end cannot precede start. Switching ending modes can retain inactive date/count
values without losing the user's prior setting. This is stored schedule data;
it does not create jobs or expand occurrences. Canonical schema validation
applies equally to authored and dynamically projected values.
