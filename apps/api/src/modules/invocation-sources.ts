// SPDX-License-Identifier: BUSL-1.1
/** One-invocation source capabilities and durable-reference revalidation. */
import { randomUUID } from "node:crypto";
import { HttpError } from "../rest/http-error.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type {
  ModuleDefinitionReference,
  ModuleEgressInvocationSource,
  ModuleInvocationSource,
  ModuleInvocationSourceResolution,
  ModuleInvocationSourceSelector,
  ModuleToolExecutionOptions,
  ModuleUnavailableInvocationSource,
} from "./contract.js";
import { sameInvocationSourceReference } from "./source-reference.js";

export type AuthorizedInvocationSource = {
  sourceReference: string;
  tenantId: string;
  actorId: string | null;
  toolName: string;
  scope: "tenant" | "personal";
  binding: number;
  definition: ModuleDefinitionReference;
  /** Hash of the exact core-owned execution snapshot; never module-visible. */
  authorityFingerprint?: string;
  /** Core-private immutable rows used by the validated execution path. */
  internal?: unknown;
  /** Re-read trusted state and return the exact current execution snapshot. */
  validate(signal?: AbortSignal): Promise<AuthorizedInvocationSource | undefined>;
};

export type AuthorizedUnavailableInvocationSource =
  ModuleUnavailableInvocationSource & {
    tenantId: string;
    actorId: string | null;
    toolName: string;
  };

export type AuthorizedInvocationSourceResolution = {
  sources: readonly AuthorizedInvocationSource[];
  unavailable: readonly AuthorizedUnavailableInvocationSource[];
};

type HeldSource = AuthorizedInvocationSource & {
  sourceHandle: string;
  invocationToken: object;
};

export type ResolvedInvocationSource = ModuleInvocationSource & {
  internal?: unknown;
  authorityFingerprint?: string;
};

/**
 * Narrow a source that has passed vault resolution to the only source metadata
 * an egress owner may coordinate on. Caller arguments and stored configuration
 * never enter this constructor.
 */
export function egressSourceFromResolvedInvocation(
  source: ResolvedInvocationSource | undefined,
): ModuleEgressInvocationSource | undefined {
  if (!source) return undefined;
  return Object.freeze({
    sourceReference: source.sourceReference,
    scope: source.scope,
  });
}

const unavailable = () =>
  new HttpError(404, "NOT_FOUND", "Invocation source is unavailable.");

type ParsedToolExecutionOptions =
  | { kind: "none" }
  | {
      kind: "handle" | "reference";
      value: string;
      expectedDefinition: ModuleDefinitionReference;
    };

function immutableDefinition(
  definition: ModuleDefinitionReference,
): ModuleDefinitionReference {
  return Object.freeze({
    kind: definition.kind,
    id: definition.id,
    version: definition.version,
  });
}

async function revalidate<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  try {
    const result = await work();
    signal?.throwIfAborted();
    return result;
  } catch {
    signal?.throwIfAborted();
    // Stored-definition and binding failures are intentionally collapsed: a
    // selector cannot be an oracle for hidden service configuration.
    throw unavailable();
  }
}

function sameDefinition(
  left: ModuleDefinitionReference | unknown,
  right: ModuleDefinitionReference | unknown,
): boolean {
  if (
    !left ||
    typeof left !== "object" ||
    !right ||
    typeof right !== "object"
  ) return false;
  const leftDefinition = left as ModuleDefinitionReference;
  const rightDefinition = right as ModuleDefinitionReference;
  return (
    typeof leftDefinition.kind === "string" &&
    leftDefinition.kind.length > 0 &&
    typeof leftDefinition.id === "string" &&
    leftDefinition.id.length > 0 &&
    Number.isInteger(leftDefinition.version) &&
    leftDefinition.version >= 1 &&
    leftDefinition.kind === rightDefinition.kind &&
    leftDefinition.id === rightDefinition.id &&
    leftDefinition.version === rightDefinition.version
  );
}

export function parseModuleToolExecutionOptions(
  options: unknown,
): ParsedToolExecutionOptions {
  if (options === undefined) return { kind: "none" };
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw unavailable();
  }
  const unsafe = options as Record<string, unknown>;
  const hasHandle = Object.hasOwn(unsafe, "sourceHandle");
  const hasReference = Object.hasOwn(unsafe, "sourceReference");
  if (hasHandle && hasReference) throw unavailable();
  if (!hasHandle && !hasReference) {
    if (Object.hasOwn(unsafe, "expectedDefinition")) throw unavailable();
    return { kind: "none" };
  }
  const kind = hasHandle ? "handle" : "reference";
  const value = unsafe[hasHandle ? "sourceHandle" : "sourceReference"];
  const expected = unsafe.expectedDefinition;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !sameDefinition(expected, expected)
  ) {
    throw unavailable();
  }
  return {
    kind,
    value,
    expectedDefinition: immutableDefinition(
      expected as ModuleDefinitionReference,
    ),
  };
}

function matchesSession(
  source: AuthorizedInvocationSource,
  session: TrustedSessionContext,
): boolean {
  return (
    source.tenantId === session.tenantId &&
    (source.scope === "tenant" || source.actorId === session.userId)
  );
}

function unavailableMatchesSession(
  source: AuthorizedUnavailableInvocationSource,
  session: TrustedSessionContext,
): boolean {
  return (
    source.tenantId === session.tenantId &&
    source.actorId === session.userId
  );
}

function exposed(
  source: AuthorizedInvocationSource & { sourceHandle: string },
  includeInternal = false,
): ResolvedInvocationSource {
  return {
    sourceHandle: source.sourceHandle,
    sourceReference: source.sourceReference,
    scope: source.scope,
    binding: source.binding,
    definition: immutableDefinition(source.definition),
    ...(includeInternal && source.internal !== undefined
      ? {
          internal: source.internal,
          ...(source.authorityFingerprint
            ? { authorityFingerprint: source.authorityFingerprint }
            : {}),
        }
      : {}),
  };
}

function exposedUnavailable(
  source: AuthorizedUnavailableInvocationSource,
): ModuleUnavailableInvocationSource {
  return {
    binding: source.binding,
    definition: immutableDefinition(source.definition),
    outcome: source.outcome,
  };
}

/** Scoped to one MCP server and discarded when that verified session closes. */
export class InvocationSourceVault {
  readonly #held = new Map<string, HeldSource>();
  readonly #handlesByInvocation = new Map<object, Map<string, string>>();
  readonly #consumedByInvocation = new Map<object, Set<string>>();

  #sourceKey(source: AuthorizedInvocationSource): string {
    return JSON.stringify([
      source.toolName,
      source.sourceReference,
      source.binding,
      source.definition.kind,
      source.definition.id,
      source.definition.version,
    ]);
  }

  async resolve(
    session: TrustedSessionContext,
    toolName: string,
    selector: ModuleInvocationSourceSelector,
    current: () => Promise<AuthorizedInvocationSourceResolution>,
    invocationToken: object,
    signal?: AbortSignal,
  ): Promise<ModuleInvocationSourceResolution> {
    signal?.throwIfAborted();
    if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
      throw unavailable();
    }
    if (
      selector.mode !== "default" &&
      selector.mode !== "all-authorized" &&
      selector.mode !== "explicit"
    ) {
      throw unavailable();
    }
    if (selector.mode === "explicit") {
      if (
        typeof selector.sourceHandle !== "string" ||
        selector.sourceHandle.length === 0 ||
        Object.hasOwn(selector, "preferredSourceReference")
      ) {
        throw unavailable();
      }
      const held = this.#held.get(selector.sourceHandle);
      if (
        !held ||
        held.toolName !== toolName ||
        held.invocationToken !== invocationToken ||
        !matchesSession(held, session)
      ) {
        throw unavailable();
      }
      const current = await revalidate(() => held.validate(signal), signal);
      if (!current || !matchesSession(current, session)) throw unavailable();
      return {
        sources: [exposed({ ...current, sourceHandle: held.sourceHandle })],
        unavailable: [],
      };
    }

    if (
      Object.hasOwn(selector, "sourceHandle") ||
      (selector.mode !== "default" &&
        Object.hasOwn(selector, "preferredSourceReference"))
    ) throw unavailable();
    const preferredSourceReference = selector.mode === "default"
      ? selector.preferredSourceReference
      : undefined;
    if (
      preferredSourceReference !== undefined &&
      (typeof preferredSourceReference !== "string" ||
        preferredSourceReference.length === 0)
    ) throw unavailable();

    const resolution = await revalidate(current, signal);
    const authorized = resolution.sources.filter(
      (source) =>
        source.toolName === toolName && matchesSession(source, session),
    );
    const unavailableSources = resolution.unavailable.filter(
      (source) =>
        source.toolName === toolName &&
        unavailableMatchesSession(source, session),
    );
    if (authorized.length === 0 && unavailableSources.length === 0) {
      throw unavailable();
    }
    const preferred = preferredSourceReference === undefined
      ? authorized
      : authorized.filter(
        (source) => sameInvocationSourceReference(
          source.sourceReference,
          preferredSourceReference,
        ),
      );
    if (preferredSourceReference !== undefined && preferred.length === 0) {
      throw unavailable();
    }
    const selected = selector.mode === "default"
      ? preferred.slice(0, 1)
      : authorized;
    const handles = this.#handlesByInvocation.get(invocationToken) ?? new Map();
    this.#handlesByInvocation.set(invocationToken, handles);
    const consumed = this.#consumedByInvocation.get(invocationToken) ?? new Set();
    this.#consumedByInvocation.set(invocationToken, consumed);
    const sources = selected.flatMap((source) => {
      const sourceKey = this.#sourceKey(source);
      if (consumed.has(sourceKey)) return [];
      const existingHandle = handles.get(sourceKey);
      const existing = existingHandle
        ? this.#held.get(existingHandle)
        : undefined;
      if (existing) return [exposed(existing)];
      const held: HeldSource = {
        ...source,
        definition: immutableDefinition(source.definition),
        sourceHandle: randomUUID(),
        invocationToken,
      };
      this.#held.set(held.sourceHandle, held);
      handles.set(sourceKey, held.sourceHandle);
      return [exposed(held)];
    });
    return {
      sources,
      unavailable: unavailableSources.map(exposedUnavailable),
    };
  }

  /**
   * Consume before awaiting revalidation. Two concurrent calls cannot both
   * pass because JavaScript deletes the handle synchronously on the first.
   */
  async consumeHandle(
    session: TrustedSessionContext,
    toolName: string,
    options: ModuleToolExecutionOptions,
    invocationToken: object,
    signal?: AbortSignal,
  ): Promise<ResolvedInvocationSource | undefined> {
    signal?.throwIfAborted();
    const parsed = parseModuleToolExecutionOptions(options);
    if (parsed.kind === "none") return undefined;
    if (parsed.kind !== "handle") throw unavailable();
    const handle = parsed.value;
    const held = this.#held.get(handle);
    this.#held.delete(handle);
    const expected = parsed.expectedDefinition;
    if (
      !held ||
      held.toolName !== toolName ||
      held.invocationToken !== invocationToken ||
      !matchesSession(held, session)
    ) {
      throw unavailable();
    }
    this.#consumedByInvocation
      .get(invocationToken)
      ?.add(this.#sourceKey(held));
    const current = await revalidate(() => held.validate(signal), signal);
    if (
      !current ||
      !matchesSession(current, session) ||
      current.authorityFingerprint !== held.authorityFingerprint ||
      !sameDefinition(current.definition, expected)
    ) throw unavailable();
    // Revalidation proves the held graph is still authoritative; execution
    // uses the original capture so a mutable row cannot silently swap the
    // operation/provider/credentials between selection and dispatch.
    return exposed(held, true);
  }

  /** Durable references are resolved only by internal, context-bound dispatch. */
  async resolveReference(
    session: TrustedSessionContext,
    toolName: string,
    options: ModuleToolExecutionOptions,
    current: (
      sourceReference: string,
    ) => Promise<AuthorizedInvocationSource | undefined>,
    signal?: AbortSignal,
  ): Promise<ResolvedInvocationSource | undefined> {
    signal?.throwIfAborted();
    const parsed = parseModuleToolExecutionOptions(options);
    if (parsed.kind === "none") return undefined;
    if (parsed.kind !== "reference") throw unavailable();
    const source = await revalidate(() => current(parsed.value), signal);
    const expected = parsed.expectedDefinition;
    if (
      !source ||
      source.toolName !== toolName ||
      !matchesSession(source, session) ||
      !sameDefinition(source.definition, expected)
    ) {
      throw unavailable();
    }
    return exposed({ ...source, sourceHandle: randomUUID() }, true);
  }

  clear(): void {
    this.#held.clear();
    this.#handlesByInvocation.clear();
    this.#consumedByInvocation.clear();
  }

  clearInvocation(invocationToken: object): void {
    for (const [handle, held] of this.#held) {
      if (held.invocationToken === invocationToken) this.#held.delete(handle);
    }
    this.#handlesByInvocation.delete(invocationToken);
    this.#consumedByInvocation.delete(invocationToken);
  }
}

export const __sameModuleDefinitionForTests = sameDefinition;
