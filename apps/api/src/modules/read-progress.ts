// SPDX-License-Identifier: BUSL-1.1
import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeOperationDefinition, RuntimeReadProgress, RuntimeReadProgressSnapshot } from "@openshapeforge/plugin-runtime";

type Frame<S> = { session: S; definition: RuntimeOperationDefinition; active: boolean; signal?: AbortSignal; observer: Observer<S> | undefined; topLevel: boolean };
type Observer<S> = { session: S; emit: (snapshot: RuntimeReadProgress) => Promise<void>; active: boolean; sequence: number; bytes: number };

/** Request-local only: no stored jobs, task records, or extra provider reads. */
export class ReadProgressRuntime<S extends object> {
  readonly #observers = new AsyncLocalStorage<Observer<S>>();
  readonly #frames = new AsyncLocalStorage<Frame<S>>();
  constructor(private readonly validateData: (data: unknown) => void) {}

  async observe<T>(session: S, emit: Observer<S>["emit"], work: () => Promise<T>): Promise<T> {
    const observer: Observer<S> = { session, emit, active: true, sequence: 0, bytes: 0 };
    try { return await this.#observers.run(observer, work); }
    finally { observer.active = false; }
  }

  async operation<T>(session: S, definition: RuntimeOperationDefinition, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const observer = this.#observers.getStore();
    const parent = this.#frames.getStore();
    const frame: Frame<S> = { session, definition, active: true, observer, topLevel: !parent || parent.observer !== observer, ...(signal ? {signal} : {}) };
    try { return await this.#frames.run(frame, work); }
    finally { frame.active = false; }
  }

  async report(session: S, snapshot: RuntimeReadProgressSnapshot): Promise<boolean> {
    const observer = this.#observers.getStore(), frame = this.#frames.getStore();
    if (!observer?.active || !frame?.active || !frame.topLevel || frame.observer !== observer || observer.session !== session || frame.session !== session || frame.signal?.aborted ||
      frame.definition.effects.data !== "read" || !["none", "read"].includes(frame.definition.effects.external) || observer.sequence >= 20) return false;
    try {
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
        (snapshot.message !== undefined && (typeof snapshot.message !== "string" || snapshot.message.length > 240)) ||
        (snapshot.data !== undefined && (!snapshot.data || typeof snapshot.data !== "object" || Array.isArray(snapshot.data)))) return false;
      this.validateData(snapshot.data);
      const json = JSON.stringify({ ...(snapshot.data ? {data: snapshot.data} : {}), ...(snapshot.message ? {message: snapshot.message} : {}) });
      const bytes = Buffer.byteLength(json);
      if (bytes > 65_536 || observer.bytes + bytes > 524_288) return false;
      const copy = JSON.parse(json) as RuntimeReadProgressSnapshot;
      // A toJSON hook can introduce keys absent from the original object.
      this.validateData(copy.data);
      // Reserve synchronously, before any await. Failed attempts still consume
      // the budget: a disconnected client must not trigger unbounded retries.
      observer.bytes += bytes;
      await observer.emit({...copy, version: 1, readOnly: true, operationId: frame.definition.id, sequence: ++observer.sequence});
      return true;
    } catch { return false; } // Progress failure must never discard the final read.
  }
}
