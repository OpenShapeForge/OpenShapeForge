// SPDX-License-Identifier: BUSL-1.1
import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeOperationDefinition, RuntimeReadProgress, RuntimeReadProgressSnapshot } from "@openshapeforge/plugin-runtime";

export type ReadProgressDefinition = Pick<RuntimeOperationDefinition, "id" | "effects">;
type Frame<S> = { session: S; definition: ReadProgressDefinition; active: boolean; signal?: AbortSignal; observer: Observer<S> | undefined; topLevel: boolean };
type Observer<S> = { session: S; emit: (snapshot: RuntimeReadProgress) => Promise<void>; active: boolean; sequence: number; bytes: number; signal?: AbortSignal };

function validSnapshot(snapshot: RuntimeReadProgressSnapshot): boolean {
  return !!snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) &&
    (snapshot.message === undefined ||
      (typeof snapshot.message === "string" && snapshot.message.length <= 240)) &&
    (snapshot.data === undefined ||
      (!!snapshot.data && typeof snapshot.data === "object" && !Array.isArray(snapshot.data)));
}

/** Request-local only: no stored jobs, task records, or extra provider reads. */
export class ReadProgressRuntime<S extends object> {
  readonly #observers = new AsyncLocalStorage<Observer<S>>();
  readonly #frames = new AsyncLocalStorage<Frame<S>>();
  constructor(
    private readonly validateData: (data: unknown) => void,
    private readonly deliveryBudgetMs = 250,
  ) {}

  async observe<T>(session: S, emit: Observer<S>["emit"], work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const observer: Observer<S> = { session, emit, active: true, sequence: 0, bytes: 0, ...(signal ? {signal} : {}) };
    try { return await this.#observers.run(observer, work); }
    finally { observer.active = false; }
  }

  async operation<T>(session: S, definition: ReadProgressDefinition, signal: AbortSignal | undefined, work: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    const observer = this.#observers.getStore();
    if (!observer?.active || observer.session !== session) return work(signal);
    const parent = this.#frames.getStore();
    const topLevel = !parent || parent.observer !== observer;
    const read = definition.effects.data === "read" && ["none", "read"].includes(definition.effects.external);
    // Opt-in read cancellation must not alter an enclosing write or an
    // ordinary client that did not opt in. Nested reads inherit their caller.
    const effectiveSignal = topLevel && read && observer?.signal
      ? (signal ? AbortSignal.any([signal, observer.signal]) : observer.signal) : signal;
    const frame: Frame<S> = { session, definition, active: true, observer, topLevel, ...(effectiveSignal ? {signal: effectiveSignal} : {}) };
    try { return await this.#frames.run(frame, () => work(effectiveSignal)); }
    finally { frame.active = false; }
  }

  async report(session: S, snapshot: RuntimeReadProgressSnapshot): Promise<boolean> {
    const observer = this.#observers.getStore(), frame = this.#frames.getStore();
    if (
      !observer?.active ||
      !frame?.active ||
      !frame.topLevel ||
      frame.observer !== observer ||
      observer.session !== session ||
      frame.session !== session ||
      frame.signal?.aborted ||
      frame.definition.effects.data !== "read" ||
      !["none", "read"].includes(frame.definition.effects.external) ||
      observer.sequence >= 20
    ) return false;
    try {
      if (!validSnapshot(snapshot)) return false;
      this.validateData(snapshot);
      const json = JSON.stringify({ ...(snapshot.data ? {data: snapshot.data} : {}), ...(snapshot.message ? {message: snapshot.message} : {}) });
      const bytes = Buffer.byteLength(json);
      if (bytes > 65_536 || observer.bytes + bytes > 524_288) return false;
      const copy = JSON.parse(json) as RuntimeReadProgressSnapshot;
      // A toJSON hook can introduce keys absent from the original object.
      if (!validSnapshot(copy)) return false;
      this.validateData(copy);
      // Reserve synchronously, before any await. Failed attempts still consume
      // the budget: a disconnected client must not trigger unbounded retries.
      observer.bytes += bytes;
      const update: RuntimeReadProgress = {
        ...copy, version: 1, readOnly: true,
        operationId: frame.definition.id, sequence: ++observer.sequence,
      };
      let abort: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const cancelled = new Promise<false>(resolve => {
          abort = () => resolve(false);
          frame.signal?.addEventListener("abort", abort, {once: true});
          if (frame.signal?.aborted) abort();
        });
        const stalled = new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), this.deliveryBudgetMs);
        });
        // Notification delivery is optional. An already queued notification
        // may drain later; clients must ignore progress after the RPC finishes.
        return await Promise.race([observer.emit(update).then(() => true), cancelled, stalled]);
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) frame.signal?.removeEventListener("abort", abort);
      }
    } catch { return false; } // Progress failure must never discard the final read.
  }
}
