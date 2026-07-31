// SPDX-License-Identifier: BUSL-1.1
/**
 * Runtime enforcement of an operation's declared reliability policy.
 *
 * The compiler already refuses a retry-eligible mutation without a declared
 * idempotency strategy, so a contract that reaches here is internally
 * consistent. This module enforces the part a contract cannot: that a retry
 * only ever happens when the contract said how duplicate side effects are
 * prevented, that the overall budget is honoured across attempts, and that one
 * tenant cannot exhaust a connector for everyone else.
 *
 * The rule that matters most: a mutation is retried ONLY when it declares
 * idempotency. Everything else here degrades gracefully under
 * misconfiguration; retrying a non-idempotent remote mutation charges a card
 * twice, and no amount of care afterwards undoes it.
 */
import { ConnectorExecutionError } from "./executor.js";

export type OperationReliability = {
  timeouts: { attemptMs: number; totalMs: number };
  retry: { eligible: boolean; maxAttempts: number; backoff: string };
  idempotency?: { strategy: string; keyInput?: string; header?: string };
  concurrency: { perTenant: number };
  rateLimit?: { perTenantPerMinute: number };
  circuitBreaker?: { failureThreshold: number; resetAfterMs: number };
};

export type OperationKind = "query" | "mutation";

/**
 * Whether a failed attempt may be tried again.
 *
 * A query is naturally safe to repeat: it has no side effects by construction,
 * which is what `kind: query` asserts. A mutation is only safe when the
 * contract declares HOW duplicates are prevented — the compiler enforces that
 * pairing, and this is the runtime half of the same rule so a hand-built or
 * stale contract cannot slip past it.
 */
export function mayRetry(
  kind: OperationKind,
  reliability: OperationReliability,
): boolean {
  if (!reliability.retry.eligible) return false;
  if (kind === "query") return true;
  return reliability.idempotency !== undefined;
}

/** Exponential backoff with a fixed base; `fixed` keeps the base flat. */
export function backoffDelayMs(
  attempt: number,
  reliability: OperationReliability,
  baseMs = 100,
): number {
  return reliability.retry.backoff === "fixed" ? baseMs : baseMs * 2 ** (attempt - 1);
}

/**
 * Per-tenant concurrency limiter.
 *
 * Scoped per (connector, operation, tenant) rather than globally: one tenant
 * hammering one operation must not starve another tenant's unrelated call, and
 * a connector's own limit is a property of the upstream it talks to.
 */
export class ConcurrencyLimiter {
  private readonly inFlight = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();

  async acquire(key: string, limit: number): Promise<() => void> {
    const current = this.inFlight.get(key) ?? 0;
    if (current < limit) {
      this.inFlight.set(key, current + 1);
      return () => this.release(key);
    }
    await new Promise<void>((resolve) => {
      const queue = this.waiting.get(key) ?? [];
      queue.push(resolve);
      this.waiting.set(key, queue);
    });
    return () => this.release(key);
  }

  private release(key: string): void {
    const queue = this.waiting.get(key);
    const next = queue?.shift();
    if (next) {
      // Hand the slot straight to the next waiter; the count stays put.
      next();
      return;
    }
    const current = this.inFlight.get(key) ?? 1;
    if (current <= 1) this.inFlight.delete(key);
    else this.inFlight.set(key, current - 1);
  }

  /** Test/observability handle: how many calls hold a slot right now. */
  active(key: string): number {
    return this.inFlight.get(key) ?? 0;
  }
}

/** Fixed-window per-tenant rate limiter. */
export class RateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  /** Returns false when the call must be refused. */
  tryConsume(key: string, perMinute: number, now: number): boolean {
    const window = this.windows.get(key);
    if (!window || now - window.startedAt >= 60_000) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (window.count >= perMinute) return false;
    window.count += 1;
    return true;
  }
}

export type BreakerState = "closed" | "open" | "half-open";

/**
 * Circuit breaker, per (connector, operation).
 *
 * Keyed without the tenant deliberately: the thing being protected is the
 * upstream system, and an upstream that is down is down for everyone. Keying
 * per tenant would let each tenant independently rediscover the outage by
 * spending its own failure budget on it.
 */
export class CircuitBreaker {
  private readonly circuits = new Map<
    string,
    { failures: number; openedAt: number | null }
  >();

  state(key: string, resetAfterMs: number, now: number): BreakerState {
    const circuit = this.circuits.get(key);
    // `openedAt` is compared against null, not truthiness: 0 is a valid
    // timestamp, and treating it as "never opened" left the breaker closed for
    // any clock starting at zero.
    if (!circuit || circuit.openedAt === null) return "closed";
    return now - circuit.openedAt >= resetAfterMs ? "half-open" : "open";
  }

  recordSuccess(key: string): void {
    this.circuits.delete(key);
  }

  recordFailure(key: string, threshold: number, now: number): void {
    const circuit = this.circuits.get(key) ?? { failures: 0, openedAt: null };
    circuit.failures += 1;
    if (circuit.failures >= threshold) circuit.openedAt = now;
    this.circuits.set(key, circuit);
  }
}

export type GovernorOptions = {
  connector: string;
  operationKey: string;
  kind: OperationKind;
  tenantId: string;
  reliability: OperationReliability;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Runs one operation under its full declared policy: rate limit, circuit
 * breaker, concurrency slot, then attempts bounded by both the per-attempt and
 * the overall budget.
 */
export class ConnectorGovernor {
  private readonly concurrency = new ConcurrencyLimiter();
  private readonly rate = new RateLimiter();
  private readonly breaker = new CircuitBreaker();

  async run<T>(options: GovernorOptions, attempt: () => Promise<T>): Promise<T> {
    const now = options.now ?? (() => Date.now());
    const sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const { reliability, connector, operationKey, tenantId } = options;

    const tenantKey = `${connector}:${operationKey}:${tenantId}`;
    const upstreamKey = `${connector}:${operationKey}`;

    if (
      reliability.rateLimit &&
      !this.rate.tryConsume(tenantKey, reliability.rateLimit.perTenantPerMinute, now())
    ) {
      throw new ConnectorExecutionError(
        "CONNECTOR_RATE_LIMITED",
        connector,
        `Connector "${connector}" operation "${operationKey}" exceeded its per-tenant rate limit.`,
        operationKey,
      );
    }

    const breakerConfig = reliability.circuitBreaker;
    if (breakerConfig) {
      const state = this.breaker.state(upstreamKey, breakerConfig.resetAfterMs, now());
      if (state === "open") {
        throw new ConnectorExecutionError(
          "CONNECTOR_CIRCUIT_OPEN",
          connector,
          `Connector "${connector}" operation "${operationKey}" is temporarily unavailable ` +
            "after repeated upstream failures.",
          operationKey,
        );
      }
    }

    const release = await this.concurrency.acquire(
      tenantKey,
      reliability.concurrency.perTenant,
    );
    const startedAt = now();
    const maxAttempts = mayRetry(options.kind, reliability)
      ? reliability.retry.maxAttempts
      : 1;

    try {
      let lastError: unknown;
      for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
        try {
          const result = await attempt();
          if (breakerConfig) this.breaker.recordSuccess(upstreamKey);
          return result;
        } catch (error) {
          lastError = error;
          if (breakerConfig) {
            this.breaker.recordFailure(upstreamKey, breakerConfig.failureThreshold, now());
          }
          if (attemptNumber >= maxAttempts) break;

          // The overall budget bounds retries independently of maxAttempts:
          // without it, three attempts at the attempt budget occupy three times
          // what the caller was told to expect.
          //
          // The test is whether the next attempt could COMPLETE in what is
          // left, not merely whether the backoff fits. Starting an attempt that
          // cannot finish inside the budget guarantees an overrun and burns the
          // upstream's capacity for a result nobody may wait for.
          const delay = backoffDelayMs(attemptNumber, reliability);
          const elapsed = now() - startedAt;
          const wouldFinishAt = elapsed + delay + reliability.timeouts.attemptMs;
          if (wouldFinishAt > reliability.timeouts.totalMs) break;
          await sleep(delay);
        }
      }
      throw lastError;
    } finally {
      release();
    }
  }

  /** Observability handle for tests. */
  activeFor(connector: string, operationKey: string, tenantId: string): number {
    return this.concurrency.active(`${connector}:${operationKey}:${tenantId}`);
  }
}
