// SPDX-License-Identifier: BUSL-1.1
/**
 * The compact record-offer format of a list page (opt-in, `offerFormat:
 * "compact"` on a list execute).
 *
 * Every row of a list page carries the same offers apart from a few per-row
 * facts: whether each Operation is available (or why not), and the record id,
 * version and any record-bound input value the binding names. The operation
 * reference, the concurrency controls and the binding's entity are the same
 * for every row. The compact page states those once per Operation in
 * `data.offerTemplates` and leaves each row only its differences.
 *
 * The format is lossless: {@link expandCompactRecordOffers} rebuilds exactly
 * the offers {@link compactRecordOffers} was given, key order included. An
 * offer its template cannot express (an interaction, a binding without a
 * record target, a binding to another record) is kept whole in the row.
 */
import type {
  OperationConcurrency,
  OperationError,
  OperationOffer,
  OperationReference,
} from "./contract.js";

/** The offer parts one Operation has in common on every row of the page. */
export type OperationOfferTemplate = {
  operation: OperationReference;
  /** Present on every available offer of this Operation. */
  concurrency?: OperationConcurrency;
  /**
   * Every available offer of this Operation binds its row's record: the
   * target is `{ entityId, id, version }` from the row's `target`, and the
   * input is `{ [idInput]: target.id, ...offer.input }`.
   */
  binding?: { entityId: string; idInput: string };
};

/** One offer of one row, relative to its Operation's template. */
export type CompactRecordOffer =
  /** Available; the template supplies the rest. `input` holds record-bound values beyond the id. */
  | { id: string; input?: Readonly<Record<string, unknown>> }
  /** Not available, with the reason. */
  | { id: string; error: OperationError }
  /** An offer the template cannot express, unchanged. */
  | { offer: OperationOffer };

/** The record a row's bound offers target. */
export type CompactRecordTarget = { id: string; version?: string };

/** A row of a compact page: its data, its record target and its offers. */
export type CompactRecordItem<TData> = {
  data: TData;
  target?: CompactRecordTarget;
  offers: CompactRecordOffer[];
};

export type CompactOfferPage<TData> = {
  offerFormat: "compact";
  offerTemplates: OperationOfferTemplate[];
  items: CompactRecordItem<TData>[];
};

/** A row of a default page. */
export type FullItem<TData> = { data: TData; operations: readonly OperationOffer[] };

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const own = (value: object, key: string) => Object.hasOwn(value, key);

/** Compact the record offers of a page's items; see the module comment. */
export function compactRecordOffers<TData>(items: readonly FullItem<TData>[]): {
  offerTemplates: OperationOfferTemplate[];
  items: CompactRecordItem<TData>[];
} {
  const templates = new Map<string, OperationOfferTemplate>();
  /** Bound templates are decided by the first AVAILABLE offer; until then only the reference is known. */
  const decided = new Set<string>();
  const compacted = items.map((item) => {
    let target: CompactRecordTarget | undefined;
    const offers = item.operations.map((offer): CompactRecordOffer => {
      const id = offer.operation.id;
      let template = templates.get(id);
      if (!template) {
        template = { operation: { ...offer.operation } };
        templates.set(id, template);
      }
      if (!sameJson(template.operation, offer.operation)) return { offer };
      if (!offer.available) {
        // `{ operation, available, error }` and nothing else is what expands back.
        return Object.keys(offer).length === 3 ? { id, error: offer.error } : { offer };
      }
      if (own(offer, "interaction")) return { offer };
      const keys = Object.keys(offer);
      const expected = ["operation", "available", ...(own(offer, "concurrency") ? ["concurrency"] : []), ...(own(offer, "binding") ? ["binding"] : [])];
      if (!sameJson(keys, expected)) return { offer };
      const binding = offer.binding;
      const bound = binding && "target" in binding && binding.target ? binding : undefined;
      if (binding && !bound) return { offer };
      const inputKeys = bound ? Object.keys(bound.input) : [];
      const idInput = inputKeys[0];
      if (bound && (idInput === undefined || bound.input[idInput] !== bound.target.id ||
        !sameJson(Object.keys(bound.target), ["entityId", "id", ...(own(bound.target, "version") ? ["version"] : [])]))) {
        return { offer };
      }
      const shape: OperationOfferTemplate = {
        operation: template.operation,
        ...(offer.concurrency ? { concurrency: offer.concurrency } : {}),
        ...(bound ? { binding: { entityId: bound.target.entityId, idInput: idInput! } } : {}),
      };
      if (!decided.has(id)) {
        decided.add(id);
        templates.set(id, shape);
        template = shape;
      } else if (!sameJson(template, shape)) {
        return { offer };
      }
      if (bound) {
        const recordTarget: CompactRecordTarget = { id: bound.target.id, ...(bound.target.version !== undefined ? { version: bound.target.version } : {}) };
        if (!target) target = recordTarget;
        else if (!sameJson(target, recordTarget)) return { offer };
        const extra = inputKeys.slice(1);
        return extra.length ? { id, input: Object.fromEntries(extra.map((key) => [key, bound.input[key]])) } : { id };
      }
      return { id };
    });
    return { data: item.data, ...(target ? { target } : {}), offers };
  });
  return { offerTemplates: [...templates.values()], items: compacted };
}

/** Rebuild the full record offers of one compact row. */
export function expandCompactRecordOffer(
  templates: ReadonlyMap<string, OperationOfferTemplate>,
  target: CompactRecordTarget | undefined,
  entry: CompactRecordOffer,
): OperationOffer {
  if ("offer" in entry) return entry.offer;
  const template = templates.get(entry.id);
  if (!template) throw new Error(`The compact offer ${entry.id} has no template.`);
  const operation = { ...template.operation };
  if ("error" in entry) return { operation, available: false, error: entry.error };
  if (template.binding && !target) throw new Error(`The compact offer ${entry.id} binds a row without a target.`);
  return {
    operation,
    available: true,
    ...(template.concurrency ? { concurrency: template.concurrency } : {}),
    ...(template.binding && target
      ? {
          binding: {
            target: { entityId: template.binding.entityId, id: target.id, ...(target.version !== undefined ? { version: target.version } : {}) },
            input: { [template.binding.idInput]: target.id, ...("input" in entry ? entry.input : {}) },
          },
        }
      : {}),
  };
}

/** A list page in either format, as a server that honored or predates the option answers. */
export type RecordOfferPage<TData, TRest extends object = Record<string, unknown>> =
  | (TRest & { items: readonly FullItem<TData>[]; offerFormat?: undefined })
  | (TRest & CompactOfferPage<TData>);

/**
 * Rebuild the default page shape (`items: [{ data, operations }]`) from a
 * compact one, other page members unchanged. A page that is not compact is
 * returned as it is, so a client can ask for the compact format and read the
 * answer of a server that predates it the same way.
 */
export function expandCompactRecordOffers<TData, TRest extends object = Record<string, unknown>>(
  page: RecordOfferPage<TData, TRest>,
): TRest & { items: FullItem<TData>[] } {
  if (page.offerFormat !== "compact") return page as TRest & { items: FullItem<TData>[] };
  const { offerFormat: _format, offerTemplates, items, ...rest } = page;
  const templates = new Map(offerTemplates.map((template) => [template.operation.id, template]));
  return {
    items: items.map((item) => ({
      data: item.data,
      operations: item.offers.map((entry) => expandCompactRecordOffer(templates, item.target, entry)),
    })),
    ...(rest as unknown as TRest),
  };
}
