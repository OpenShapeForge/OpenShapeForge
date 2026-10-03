# UI localization

Web metadata retains English and Dutch together. The web consumer chooses a language after verifying its session; it must not use unverified token claims as identity or language authority. `normalizeUiLocale` resolves regional tags such as `nl-NL` and `en-GB` to `nl` and `en`. Unsupported or malformed UI language tags use English. Missing display text falls back to English, then Dutch, then the supplied fallback.

Operation JSON Schema keeps standard `title` and `description` as strings. Use the presentation annotation for multilingual copy:

```yaml
customerId:
  type: string
  x-osf-i18n:
    title: { en: Customer, nl: Klant }
    description:
      en: Select the customer for this offer.
      nl: Kies de klant voor deze offerte.
```

String choices use `x-osf-i18n.enum`, indexed by the original enum value. Nested `properties`, `items`, and schema variants carry the same annotation. `localizeInputSchema` returns a copy; it does not change keys, constants, defaults, enum values, or submitted data. Technical transport descriptions remain available to API clients; when a field has presentation metadata, only its localized description is shown as UI help.

Entity-derived input schemas retain field labels and static option labels. An `x-osf-entityInput` may add presentation metadata without overriding its entity validation contract.

`buildWebManifest({ requireTranslations: true })` rejects missing English or Dutch labels on operation inputs, outputs and string choices, with the full schema path. All authored presentation annotations are checked for incomplete language pairs, including nested fields. Authored entity, field, action, view and menu language maps are checked before fallback fills a missing language. Plain strings remain language-neutral legacy metadata; use language maps for translated copy. Existing consumers may leave strict coverage disabled during migration.

Authoring layers use the existing strategic merge: nested language maps merge by language key. An override of `nl` preserves an inherited `en`. Configured layers are applied in order, followed by registered plugin authoring layers; this change does not reorder layers. A host must use the composition order defined by its compiler configuration.

These rules select UI copy only. Customer-entered text and a document's separately selected output language remain unchanged.
