// SPDX-License-Identifier: BUSL-1.1
/**
 * The resolution core shared by reading content (./materialize.ts) and
 * capturing it into a host-owned copy (./capture.ts): authorized dependency
 * reads, the typed variable binding and the size budgets. One engine serves
 * one request, so every dependency is read once and counted once.
 */
import {
  isPageVariableKey,
  assertVariableCompatible,
  assertVariableSourceValue,
  assertVariableUsagePermitted,
  escapeMarkdownVariableText,
  isDeclaredVariableNamespace,
  permitsVariableUsage,
  variableText,
  variableTokens,
  wholeVariableExpression,
  type VariableCatalogue,
  type VariableOffer,
  type VariableReference,
  type VariableSlot,
} from "@openshapeforge/operations";
import { contentError } from "./errors.js";
import { canonicalJson, CONTENT_LIMITS, immutableContent, type JsonObject, type JsonValue } from "./json.js";
import type {
  CompiledContentBlockDefinition,
  ContentBlock,
  ContentEntityReference,
  ContentResolvedEntity,
  ContentResolvedPath,
  ContentResolvedVariable,
  ContentResolvers,
  ContentTemplateVersion,
  ContentValueShape,
} from "./types.js";
import { assertContentName, assertContentRecord, defineContentTemplateVersion, validateContentBlockReferences } from "./validation.js";
import {
  contentGlobalVariableOffer,
  contentItemShape,
  contentVariableFailure,
  contentVariableOffer,
  contentVariableReference,
  contentVariableSlot,
} from "./variables.js";

/**
 * What a capture keeps unresolved. A variable whose input the host has not
 * supplied yet is not read: `defer` returns the text that stands for it in
 * the host's own scope and `deferParameter` the host parameter a typed
 * reference is bound to instead. The two flags report, per captured block,
 * that a binding was kept and that resolved data containing `{{` or `}}` was
 * written where the host will bind again.
 */
export type CaptureState = {
  readonly defer: (reference: VariableReference) => string | undefined;
  readonly deferParameter: (name: string) => string | undefined;
  deferred: boolean;
  literalBraces: boolean;
};

/** The variables and their values one scope's blocks may name. */
export type VariableScope = {
  readonly catalogue: VariableCatalogue;
  readonly parameters: JsonObject;
  readonly capture?: CaptureState;
};

const BRACES = /\{\{|\}\}/;

/** Whether any text inside a JSON value could be read as a variable token again. */
export function holdsBraces(value: unknown): boolean {
  if (typeof value === "string") return BRACES.test(value);
  if (Array.isArray(value)) return value.some(holdsBraces);
  if (value && typeof value === "object") return Object.values(value).some(holdsBraces);
  return false;
}

export type ContentEngine = ReturnType<typeof createContentEngine>;

export function createContentEngine(
  request: { readonly tenantId: string; readonly locale: string },
  resolvers: ContentResolvers,
) {
  const context = Object.freeze({ tenantId: request.tenantId });
  const versions = new Map<string, ContentTemplateVersion>();
  const entities = new Map<string, ContentResolvedEntity>();
  const globals: Record<string, ContentResolvedVariable> = Object.create(null);
  const paths: Record<string, ContentResolvedPath> = Object.create(null);
  let dependencyCount = 0;
  let visitedBlocks = 0;
  let expandedCharacters = 0;

  function accountExpandedContent(value: unknown) {
    expandedCharacters += canonicalJson(value).length;
    if (expandedCharacters > CONTENT_LIMITS.stringCharacters)
      contentError("CONTENT_LIMIT_EXCEEDED", "Expanded content exceeds the aggregate size budget.");
  }
  function countDependency() {
    if (++dependencyCount > CONTENT_LIMITS.dependencies)
      contentError("CONTENT_LIMIT_EXCEEDED", "Too many content dependencies.");
  }
  function countBlock() {
    if (++visitedBlocks > CONTENT_LIMITS.blocks)
      contentError("CONTENT_LIMIT_EXCEEDED", "Expanded template contains too many blocks.");
  }

  async function template(id: string) {
    const previous = versions.get(id);
    if (previous) return previous;
    countDependency();
    const resolved = await resolvers.resolveTemplateVersion(id, context);
    if (!resolved)
      contentError("DEPENDENCY_UNRESOLVED", "Required template version could not be resolved.");
    const version = defineContentTemplateVersion(resolved);
    if (version.tenantId !== request.tenantId || version.id !== id)
      contentError("DEPENDENCY_INVALID", "Template version resolved to a different tenant or identity.");
    versions.set(id, version);
    return version;
  }

  /**
   * One global, with the contract its own source declares for it. A Chip
   * stores the FieldDefinition that types its value, so the shape is not
   * known before the key is resolved: the authorized read happens first and
   * the declared shape it returns is what the destination is compared
   * against. The identity, version, tenant and shape are frozen exactly as
   * they were read.
   */
  async function global(key: string): Promise<ContentResolvedVariable> {
    if (Object.hasOwn(globals, key)) return globals[key]!;
    countDependency();
    const resolved = await resolvers.resolveGlobalVariable(key, context);
    if (!resolved)
      contentError("MISSING_VARIABLE", `Global variable ${key} could not be resolved.`);
    // Before the result is frozen: a source that does not state the contract
    // of its own value is a broken dependency, not an untyped value.
    if (!resolved.shape || typeof resolved.shape !== "object" || typeof resolved.shape.baseType !== "string")
      contentError("DEPENDENCY_INVALID", `Global variable ${key} declares no value type.`);
    const value = immutableContent({
      tenantId: resolved.tenantId,
      sourceId: resolved.sourceId,
      sourceVersionId: resolved.sourceVersionId,
      shape: resolved.shape,
      value: resolved.value,
    });
    if (value.tenantId !== request.tenantId)
      contentError("DEPENDENCY_INVALID", "Global variable resolved outside the template tenant.");
    assertContentName(value.sourceId, "global variable source id");
    assertContentName(value.sourceVersionId, "global variable source version");
    if (!Object.hasOwn(value, "value"))
      contentError("DEPENDENCY_INVALID", "Global variable has no snapshot value.");
    globals[key] = value;
    return value;
  }

  /**
   * One record parameter followed through its relationships: `deal.relationId.name`
   * is the parameter `deal`, then the path `relationId.name` from the record it
   * names. The adapter reads every step under its authorization; the result,
   * and every record read for it, is kept once per record and path.
   */
  async function follow(key: string, scope: VariableScope): Promise<ContentResolvedPath> {
    const separator = key.indexOf(".");
    const name = key.slice(0, separator);
    const path = key.slice(separator + 1);
    const parameter = contentVariableOffer(scope.catalogue, contentVariableReference(`local.${name}`));
    if (!parameter.target || parameter.cardinality !== "single")
      contentError("INVALID_VALUE", `local.${name} is not a record parameter; only a record can be followed.`);
    const id = Object.hasOwn(scope.parameters, name) ? scope.parameters[name] : undefined;
    if (typeof id !== "string" || !id)
      contentError("MISSING_VARIABLE", `local.${name} has no record to follow.`);
    const cacheKey = `${parameter.target}:${id}:${path}`;
    if (Object.hasOwn(paths, cacheKey)) return paths[cacheKey]!;
    if (!resolvers.resolveVariablePath)
      contentError("DEPENDENCY_UNRESOLVED", "This content runtime cannot follow a record parameter.");
    countDependency();
    const read = await resolvers.resolveVariablePath({ entity: parameter.target, id }, path, context);
    if (!read) contentError("MISSING_VARIABLE", `local.${key} could not be read.`);
    const value = immutableContent(read);
    if (value.root.entity !== parameter.target || value.root.id !== id || value.path !== path)
      contentError("DEPENDENCY_INVALID", `local.${key} resolved to a different record or path.`);
    if (!value.shape || typeof value.shape.baseType !== "string")
      contentError("DEPENDENCY_INVALID", `local.${key} declares no value type.`);
    for (const source of value.sources) {
      assertContentName(source.id, "path source id");
      assertContentName(source.versionId, "path source version");
    }
    paths[cacheKey] = value;
    return value;
  }

  /**
   * The offer and value of one reference, read under the adapter's
   * authorization. `slot` adds the destination's contract: without one the
   * value is read as its own source types it, which is what rewriting an
   * already-typed record of inputs needs.
   */
  async function bind(
    expression: string,
    slot: VariableSlot | undefined,
    usage: "whole" | "template",
    scope: VariableScope,
  ): Promise<{ readonly offer: VariableOffer; readonly value: JsonValue }> {
    const reference = contentVariableReference(expression);
    const permitted = () => {
      if (!slot) return;
      try {
        assertVariableUsagePermitted(slot, usage);
      } catch (error) {
        contentVariableFailure(error);
      }
    };
    // A namespace whose keys declare their own contract is resolved before it
    // can be compared: the read is authorized either way, and the shape it
    // returns is the source's, never the caller's. The shape a template may
    // not bind at all — a mode the field does not author — is still refused
    // first, so an unbindable field reads no global.
    const declared = isDeclaredVariableNamespace(scope.catalogue, reference.namespace);
    if (declared) permitted();
    // `local.<parameter>.<path>` follows a record parameter through its
    // relationships. Its type is the path's, known only after the authorized
    // read, so it is compared like a global: read first, then checked.
    const followed = !declared && reference.namespace === "local" && reference.key.includes(".")
      ? await follow(reference.key, scope) : undefined;
    if (followed) permitted();
    const resolved = declared ? await global(reference.key) : followed;
    const offer = resolved
      ? contentGlobalVariableOffer(reference, resolved)
      : contentVariableOffer(scope.catalogue, reference);
    if (slot) {
      try {
        assertVariableCompatible(slot, offer, usage);
      } catch (error) {
        contentVariableFailure(error);
      }
    }
    const value = resolved
      ? resolved.value
      : Object.hasOwn(scope.parameters, reference.key) ? scope.parameters[reference.key] : undefined;
    try {
      assertVariableSourceValue(offer, value);
    } catch (error) {
      contentVariableFailure(error);
    }
    return { offer, value: value as JsonValue };
  }

  /** One string, its tokens filled or kept. `slot` absent reads untyped (see `bind`). */
  async function interpolateText(
    value: string,
    slot: VariableSlot | undefined,
    scope: VariableScope,
    markdown: boolean,
  ): Promise<JsonValue> {
    const capture = scope.capture;
    // One unbounded run per `{{`, trimmed by the reference parser:
    // surrounding `\s*` around a lazy group backtracks cubically on an
    // unclosed `{{`.
    const whole = wholeVariableExpression(value);
    const wholeReference = whole === undefined ? undefined : contentVariableReference(whole);
    // A page variable is text the page renderer fills, even when it is all the field holds.
    const pageOnly = wholeReference?.namespace === "page";
    if (pageOnly && slot && !permitsVariableUsage(slot.mode, "template"))
      contentError("INVALID_VALUE", "A page variable is text inside a template, not a field's value.");
    if (wholeReference && !pageOnly && (!slot || permitsVariableUsage(slot.mode, "whole"))) {
      const kept = capture?.defer(wholeReference);
      if (kept !== undefined) {
        capture!.deferred = true;
        return kept;
      }
      // The typed value of the variable is the value of the field; it is
      // data, not Markdown source, so it is not escaped here.
      const bound = (await bind(whole!, slot, "whole", scope)).value;
      if (capture && holdsBraces(bound)) {
        // A capture stores this value where the host may bind again. A whole value bound into Markdown is Markdown
        // itself, so only its brace pairs are escaped: they print the same and can never be read as a variable. Any
        // other destination has no such spelling.
        if (markdown && typeof bound === "string") return bound.replace(/\{\{|\}\}/g, (pair) => `\\${pair[0]}\\${pair[1]}`);
        capture.literalBraces = true;
      }
      return bound;
    }
    const matches = variableTokens(value);
    if (matches.length > 0 && slot) {
      try {
        assertVariableUsagePermitted(slot, "template");
      } catch (error) {
        contentVariableFailure(error);
      }
    }
    let result = "";
    let offset = 0;
    for (const match of matches) {
      const literal = value.slice(offset, match.index);
      if (BRACES.test(literal))
        contentError("INVALID_VALUE", "Malformed variable expression.");
      offset = match.index + match[0].length;
      // A fact of the printed page is filled by the page renderer on every
      // page; it stays as written here.
      const reference = contentVariableReference(match[1]!);
      if (reference.namespace === "page") {
        if (!isPageVariableKey(reference.key)) contentError("INVALID_VALUE", `page.${reference.key} is not a page variable.`);
        result += literal + `{{page.${reference.key}}}`;
        continue;
      }
      const kept = capture?.defer(reference);
      if (kept !== undefined) {
        capture!.deferred = true;
        result += literal + kept;
        continue;
      }
      const bound = await bind(match[1]!, slot, "template", scope);
      let text: string;
      try {
        text = printedValue(bound.offer.osfType, bound.value, request.locale) ?? variableText(bound.value);
      } catch (error) {
        contentVariableFailure(error);
      }
      if (markdown) text = escapeMarkdownVariableText(text);
      else if (capture && BRACES.test(text)) capture.literalBraces = true;
      if (result.length + literal.length + text.length > CONTENT_LIMITS.stringCharacters)
        contentError("CONTENT_LIMIT_EXCEEDED", "Expanded text exceeds the size budget.");
      result += literal + text;
    }
    const remaining = value.slice(offset);
    if (BRACES.test(remaining))
      contentError("INVALID_VALUE", "Malformed variable expression.");
    if (result.length + remaining.length > CONTENT_LIMITS.stringCharacters)
      contentError("CONTENT_LIMIT_EXCEEDED", "Expanded text exceeds the size budget.");
    return result + remaining;
  }

  /**
   * Fill the variables of one authored value, under the contract of the field
   * that holds it.
   *
   * A field that authors no mode takes literals only: its text is returned
   * untouched, so `{{` in ordinary content is content. A field that permits a
   * whole-value binding and holds exactly one token is bound to that
   * variable's typed value — resolved first, then validated by the field's
   * own canonical validator after substitution. A field that permits a
   * template has every token replaced by the variable's formatted text, and a
   * Markdown destination escapes each replacement so a value cannot become
   * syntax.
   */
  async function interpolate(
    value: JsonValue,
    shape: ContentValueShape | undefined,
    path: string,
    scope: VariableScope,
    markdown: boolean,
  ): Promise<JsonValue> {
    if (typeof value === "string") {
      const slot = contentVariableSlot(path, shape);
      return slot.mode === "none" ? value : interpolateText(value, slot, scope, markdown);
    }
    if (Array.isArray(value)) {
      // A collection's rows hold values of the same type, one at a time.
      const item = shape ? contentItemShape(shape) : undefined;
      const result: JsonValue[] = [];
      for (const child of value) result.push(await interpolate(child, item, path, scope, markdown));
      return result;
    }
    if (value && typeof value === "object") {
      const fields = shape?.fields;
      const result: Record<string, JsonValue> = Object.create(null);
      for (const key of Object.keys(value).sort()) {
        // Only a declared child has a contract to bind against. An object
        // whose entries are not declared holds literals.
        const child = fields && Object.hasOwn(fields, key) ? fields[key] : undefined;
        result[key] = await interpolate((value as JsonObject)[key]!, child, `${path}.${key}`, scope, markdown);
      }
      return result;
    }
    return value;
  }

  /**
   * The inputs an inclusion recorded, moved into another scope: every token in
   * a top-level text value is filled or kept by the same binding, without a
   * destination contract. The values were typed against the included
   * template when they were written and are typed again when they are used.
   */
  async function rescope(values: JsonObject, scope: VariableScope): Promise<JsonObject> {
    const result: Record<string, JsonValue> = Object.create(null);
    for (const key of Object.keys(values).sort()) {
      const value = values[key]!;
      result[key] = typeof value === "string" && variableTokens(value).length ? await interpolateText(value, undefined, scope, false) : value;
    }
    return result;
  }

  /**
   * The typed references of one block with every parameter binding settled.
   * The stored spelling of a local binding on a typed reference: a reference
   * is never text, so the binding is its own structure instead of a token
   * inside a string. The name is bounded by the column that holds it, and the
   * binding itself goes through the same compatibility comparison as
   * `{{local.key}}`.
   */
  function bindReferences(block: ContentBlock, definition: CompiledContentBlockDefinition, scope: VariableScope): ContentBlock {
    const bound = Object.fromEntries(Object.entries(block.references).map(([key, reference]) => {
      if (!reference || Array.isArray(reference) || !("parameter" in reference)) return [key, reference];
      const name = reference.parameter;
      if (Object.keys(reference).length !== 1 || !/^[a-z][A-Za-z0-9]{0,127}$/.test(name)) contentError("INVALID_VALUE", "Invalid local parameter binding.");
      const field = Object.hasOwn(definition.fields, key) ? definition.fields[key] : undefined;
      const slot = contentVariableSlot(`block references.${key}`, field);
      if (!slot.target) contentError("DEPENDENCY_INVALID", `${key} is not a typed reference, so it takes no parameter binding.`);
      const offer = contentVariableOffer(scope.catalogue, contentVariableReference(`local.${name}`));
      try {
        assertVariableCompatible(slot, offer, "whole");
      } catch (error) {
        contentVariableFailure(error);
      }
      const kept = scope.capture?.deferParameter(name);
      if (kept !== undefined) {
        scope.capture!.deferred = true;
        return [key, { parameter: kept }];
      }
      try {
        assertVariableSourceValue(offer, Object.hasOwn(scope.parameters, name) ? scope.parameters[name] : undefined);
      } catch (error) {
        contentVariableFailure(error);
      }
      return [key, { entity: slot.target, id: scope.parameters[name] as string }];
    }));
    const result: ContentBlock = { ...block, references: bound as ContentBlock["references"] };
    // A binding a capture kept is checked as the typed slot it fills: the record itself is named when the host supplies it.
    const references: Record<string, ContentBlock["references"][string]> = {};
    for (const [key, reference] of Object.entries(result.references))
      references[key] = reference && !Array.isArray(reference) && "parameter" in reference ? { entity: definition.fields[key]!.relationship!.target, id: reference.parameter } : reference;
    validateContentBlockReferences({ ...result, references }, definition);
    return result;
  }

  async function entity(reference: ContentEntityReference) {
    const identity = canonicalJson([reference.entity, reference.id, reference.versionId ?? null]);
    const previous = entities.get(identity);
    if (previous) return previous;
    countDependency();
    const resolved = await resolvers.resolveEntity(reference, context);
    if (!resolved)
      contentError("DEPENDENCY_UNRESOLVED", "Required entity reference could not be resolved.");
    const value = immutableContent({
      tenantId: resolved.tenantId,
      entity: resolved.entity,
      id: resolved.id,
      versionId: resolved.versionId,
      value: resolved.value,
    });
    if (
      value.tenantId !== request.tenantId ||
      value.entity !== reference.entity ||
      value.id !== reference.id ||
      (reference.versionId !== undefined && value.versionId !== reference.versionId)
    ) {
      contentError(
        "DEPENDENCY_INVALID",
        "Entity reference resolved to a different tenant, type, identity, or pinned version.",
      );
    }
    assertContentName(value.versionId, "entity source version");
    assertContentRecord(value.value, "entity snapshot values");
    entities.set(identity, value);
    return value;
  }

  /** Every concrete reference of a block, read under the adapter's authorization; a parameter binding resolves to nothing yet. */
  async function resolveReferences(block: ContentBlock, skip?: string): Promise<Record<string, ContentResolvedEntity | readonly ContentResolvedEntity[] | null>> {
    const references: Record<string, ContentResolvedEntity | readonly ContentResolvedEntity[] | null> = Object.create(null);
    for (const key of Object.keys(block.references).sort()) {
      if (key === skip) continue;
      const reference = block.references[key];
      if (reference == null || (!Array.isArray(reference) && "parameter" in reference)) references[key] = null;
      else if (Array.isArray(reference)) {
        const resolved: ContentResolvedEntity[] = [];
        for (const item of reference) resolved.push(await entity(item));
        references[key] = resolved;
      } else references[key] = await entity(reference as ContentEntityReference);
    }
    return references;
  }

  return { template, interpolate, rescope, bindReferences, resolveReferences, accountExpandedContent, countBlock, globals, paths };
}

/**
 * A date as a reader meets it in running text: "11 mei 2026", "11 May 2026".
 *
 * Only a `date` variable spliced into a template is printed this way. A whole
 * binding keeps the typed ISO value, because the field it fills is a date. A
 * datetime keeps its ISO spelling: printing one needs a time zone the content
 * engine does not have. A bare `en` reads day-month-year, the order the rest
 * of the document's locales use; a region the author chose (`en-US`) is kept.
 * A locale the platform does not know, or a value that is not a calendar
 * date, falls through to the stored text.
 *
 * An IBAN is stored without spaces and reads in groups of four, the way it is
 * printed on paper: "NL77 RABO 0333 5802 14".
 */
function printedValue(osfType: string | undefined, value: unknown, locale: string): string | undefined {
  if (typeof value !== "string") return undefined;
  if (osfType === "iban") return value.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
  if (osfType !== "date") return undefined;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return undefined;
  const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
  if (date.toISOString().slice(0, 10) !== value) return undefined;
  try {
    return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : locale, { dateStyle: "long", timeZone: "UTC" }).format(date);
  } catch {
    return undefined;
  }
}
