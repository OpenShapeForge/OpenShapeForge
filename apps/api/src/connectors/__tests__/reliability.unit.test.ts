// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  CircuitBreaker,
  ConcurrencyLimiter,
  ConnectorGovernor,
  RateLimiter,
  backoffDelayMs,
  mayRetry,
  type OperationReliability,
} from "../reliability.js";
import { ConnectorExecutionError } from "../executor.js";
import type { ConnectorProviderOutcome } from "../provider-outcome.js";

function reliability(
  overrides: Partial<OperationReliability> = {},
): OperationReliability {
  return {
    timeouts: { attemptMs: 1_000, totalMs: 10_000 },
    retry: { eligible: true, maxAttempts: 3, backoff: "fixed" },
    concurrency: { perTenant: 4 },
    ...overrides,
  };
}

const NO_SLEEP = async () => {};

describe("the retry gate", () => {
  // The rule the whole stage exists for. Retrying a non-idempotent remote
  // mutation charges a card twice, and nothing afterwards undoes it.
  it("never retries a mutation without a declared idempotency strategy", () => {
    expect(mayRetry("mutation", reliability())).toBe(false);
  });

  it("retries a mutation that declares one", () => {
    expect(
      mayRetry("mutation", reliability({ idempotency: { strategy: "natural" } })),
    ).toBe(true);
  });

  // A query has no side effects by construction — that is what `kind: query`
  // asserts — so repeating it is safe without further declaration.
  it("retries a query without needing an idempotency declaration", () => {
    expect(mayRetry("query", reliability())).toBe(true);
  });

  it("never retries when the contract opted out", () => {
    const off = reliability({ retry: { eligible: false, maxAttempts: 5, backoff: "fixed" } });
    expect(mayRetry("query", off)).toBe(false);
    expect(mayRetry("mutation", { ...off, idempotency: { strategy: "natural" } })).toBe(false);
  });

  it("makes exactly one attempt for a non-retryable mutation that fails", async () => {
    const governor = new ConnectorGovernor();
    let attempts = 0;
    await expect(
      governor.run(
        {
          connector: "c",
          operationKey: "putObject",
          kind: "mutation",
          tenantId: "t1",
          reliability: reliability(),
          sleep: NO_SLEEP,
        },
        async () => {
          attempts += 1;
          throw new Error("upstream down");
        },
      ),
    ).rejects.toThrow("upstream down");
    expect(attempts).toBe(1);
  });

  it("retries up to maxAttempts for an idempotent mutation", async () => {
    const governor = new ConnectorGovernor();
    let attempts = 0;
    await expect(
      governor.run(
        {
          connector: "c",
          operationKey: "putObject",
          kind: "mutation",
          tenantId: "t1",
          reliability: reliability({ idempotency: { strategy: "natural" } }),
          sleep: NO_SLEEP,
        },
        async () => {
          attempts += 1;
          throw new Error("upstream down");
        },
      ),
    ).rejects.toThrow("upstream down");
    expect(attempts).toBe(3);
  });

  it("stops as soon as an attempt succeeds", async () => {
    const governor = new ConnectorGovernor();
    let attempts = 0;
    const result = await governor.run(
      {
        connector: "c",
        operationKey: "listObjects",
        kind: "query",
        tenantId: "t1",
        reliability: reliability(),
        sleep: NO_SLEEP,
      },
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("flaky");
        return "ok";
      },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });
});

describe("the overall budget bounds retries", () => {
  // Without it, three attempts at the attempt budget occupy three times what
  // the caller was told to expect.
  it("stops retrying once the total budget would be exceeded", async () => {
    const governor = new ConnectorGovernor();
    let clock = 0;
    let attempts = 0;

    await expect(
      governor.run(
        {
          connector: "c",
          operationKey: "listObjects",
          kind: "query",
          tenantId: "t1",
          reliability: reliability({
            timeouts: { attemptMs: 1_000, totalMs: 1_200 },
            retry: { eligible: true, maxAttempts: 5, backoff: "fixed" },
          }),
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
        async () => {
          attempts += 1;
          clock += 1_000; // each attempt burns its full budget
          throw new Error("slow upstream");
        },
      ),
    ).rejects.toThrow("slow upstream");

    // maxAttempts was 5, but the total budget only affords the first.
    expect(attempts).toBe(1);
  });

  it("uses exponential backoff by default and flat when asked", () => {
    const exponential = reliability({
      retry: { eligible: true, maxAttempts: 4, backoff: "exponential" },
    });
    expect([1, 2, 3].map((n) => backoffDelayMs(n, exponential, 100))).toEqual([100, 200, 400]);
    expect([1, 2, 3].map((n) => backoffDelayMs(n, reliability(), 100))).toEqual([100, 100, 100]);
  });
});

describe("per-tenant concurrency", () => {
  it("holds calls beyond the limit until a slot frees", async () => {
    const limiter = new ConcurrencyLimiter();
    const first = await limiter.acquire("k", 1);
    expect(limiter.active("k")).toBe(1);

    let secondAcquired = false;
    const second = limiter.acquire("k", 1).then((release) => {
      secondAcquired = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(secondAcquired).toBe(false); // still queued behind the first

    first();
    const release = await second;
    expect(secondAcquired).toBe(true);
    release();
  });

  it("isolates tenants from each other", async () => {
    const governor = new ConnectorGovernor();
    const started: string[] = [];
    const release: (() => void)[] = [];

    const hold = (tenantId: string) =>
      governor.run(
        {
          connector: "c",
          operationKey: "listObjects",
          kind: "query",
          tenantId,
          reliability: reliability({ concurrency: { perTenant: 1 } }),
          sleep: NO_SLEEP,
        },
        () =>
          new Promise<void>((resolve) => {
            started.push(tenantId);
            release.push(resolve);
          }),
      );

    const a = hold("t1");
    const b = hold("t2");
    await new Promise((resolve) => setTimeout(resolve, 5));

    // One tenant saturating its slot must not stall another's unrelated call.
    expect(started.sort()).toEqual(["t1", "t2"]);
    release.forEach((resolve) => resolve());
    await Promise.all([a, b]);
  });
});

describe("per-tenant rate limit", () => {
  it("refuses past the limit and recovers in the next window", () => {
    const limiter = new RateLimiter();
    expect(limiter.tryConsume("t1", 2, 0)).toBe(true);
    expect(limiter.tryConsume("t1", 2, 10)).toBe(true);
    expect(limiter.tryConsume("t1", 2, 20)).toBe(false);
    // Another tenant has its own window.
    expect(limiter.tryConsume("t2", 2, 20)).toBe(true);
    // Next minute.
    expect(limiter.tryConsume("t1", 2, 60_001)).toBe(true);
  });

  it("surfaces a stable code without running the attempt", async () => {
    const governor = new ConnectorGovernor();
    const options = {
      connector: "c",
      operationKey: "listObjects",
      kind: "query" as const,
      tenantId: "t1",
      reliability: reliability({ rateLimit: { perTenantPerMinute: 1 } }),
      sleep: NO_SLEEP,
    };
    let attempts = 0;
    const attempt = async () => {
      attempts += 1;
      return "ok";
    };

    expect(await governor.run(options, attempt)).toBe("ok");
    try {
      await governor.run(options, attempt);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as ConnectorExecutionError).code).toBe("CONNECTOR_RATE_LIMITED");
    }
    expect(attempts).toBe(1);
  });
});

describe("circuit breaker", () => {
  it("opens at the threshold and half-opens after the reset window", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure("k", 2, 0);
    expect(breaker.state("k", 1_000, 0)).toBe("closed");
    breaker.recordFailure("k", 2, 10);
    expect(breaker.state("k", 1_000, 10)).toBe("open");
    expect(breaker.state("k", 1_000, 1_010)).toBe("half-open");
  });

  it("closes again on success", () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure("k", 1, 0);
    expect(breaker.state("k", 1_000, 0)).toBe("open");
    breaker.recordSuccess("k");
    expect(breaker.state("k", 1_000, 0)).toBe("closed");
  });

  it("refuses calls while open, then lets one through after the reset", async () => {
    const governor = new ConnectorGovernor();
    let clock = 0;
    let attempts = 0;
    const options = {
      connector: "c",
      operationKey: "listObjects",
      kind: "query" as const,
      tenantId: "t1",
      reliability: reliability({
        retry: { eligible: false, maxAttempts: 1, backoff: "fixed" },
        circuitBreaker: { failureThreshold: 1, resetAfterMs: 500 },
      }),
      now: () => clock,
      sleep: NO_SLEEP,
    };

    await expect(
      governor.run(options, async () => {
        attempts += 1;
        throw new Error("upstream down");
      }),
    ).rejects.toThrow("upstream down");
    expect(attempts).toBe(1);

    // Open: refused without touching the upstream.
    try {
      await governor.run(options, async () => {
        attempts += 1;
        return "ok";
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as ConnectorExecutionError).code).toBe("CONNECTOR_CIRCUIT_OPEN");
    }
    expect(attempts).toBe(1);

    // Half-open after the reset window: one probe is allowed through.
    clock = 600;
    expect(
      await governor.run(options, async () => {
        attempts += 1;
        return "ok";
      }),
    ).toBe("ok");
    expect(attempts).toBe(2);
  });

  // The upstream is what is being protected, and an upstream that is down is
  // down for everyone; keying per tenant would make each tenant rediscover the
  // outage with its own failure budget.
  it("is shared across tenants", async () => {
    const governor = new ConnectorGovernor();
    const options = (tenantId: string) => ({
      connector: "c",
      operationKey: "listObjects",
      kind: "query" as const,
      tenantId,
      reliability: reliability({
        retry: { eligible: false, maxAttempts: 1, backoff: "fixed" },
        circuitBreaker: { failureThreshold: 1, resetAfterMs: 10_000 },
      }),
      sleep: NO_SLEEP,
    });

    await expect(
      governor.run(options("t1"), async () => {
        throw new Error("upstream down");
      }),
    ).rejects.toThrow("upstream down");

    try {
      await governor.run(options("t2"), async () => "ok");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as ConnectorExecutionError).code).toBe("CONNECTOR_CIRCUIT_OPEN");
    }
  });
});

/**
 * A classified provider outcome can only ever remove attempts. The policy
 * above decided how many there may be; a provider that says "not retryable"
 * or names a time beyond the budget shortens that, and one that says
 * "retryable" adds nothing to a mutation the contract never made safe.
 */
describe("provider outcomes and the retry loop", () => {
  const NOW = 1_000_000;

  function classified(
    outcome: Partial<ConnectorProviderOutcome> & Pick<ConnectorProviderOutcome, "retryable">,
  ): ConnectorExecutionError {
    return new ConnectorExecutionError(
      "CONNECTOR_PROVIDER_UNAVAILABLE",
      "c",
      "unavailable",
      "op",
      {
        outcome: {
          code: "CONNECTOR_PROVIDER_UNAVAILABLE",
          category: "availability",
          requiredAction: "wait",
          correlationId: "corr",
          ...outcome,
        },
      },
    );
  }

  async function attemptsUntilFailure(
    error: ConnectorExecutionError,
    kind: "query" | "mutation" = "query",
    policy: OperationReliability = reliability(),
  ): Promise<number> {
    const governor = new ConnectorGovernor();
    let attempts = 0;
    await expect(
      governor.run(
        {
          connector: "c",
          operationKey: "op",
          kind,
          tenantId: "t",
          reliability: policy,
          now: () => NOW,
          sleep: NO_SLEEP,
        },
        async () => {
          attempts += 1;
          throw error;
        },
      ),
    ).rejects.toBe(error);
    return attempts;
  }

  it("does not retry a failure the classification says is not retryable", async () => {
    expect(await attemptsUntilFailure(classified({ retryable: false }))).toBe(1);
  });

  it("still retries a retryable failure up to the policy's attempts", async () => {
    expect(await attemptsUntilFailure(classified({ retryable: true }))).toBe(3);
  });

  it("does not retry in-call when retryAt lies beyond the remaining budget", async () => {
    const beyond = new Date(NOW + 60_000).toISOString(); // budget is 10s
    expect(await attemptsUntilFailure(classified({ retryable: true, retryAt: beyond }))).toBe(1);
    const within = new Date(NOW + 2_000).toISOString();
    expect(await attemptsUntilFailure(classified({ retryable: true, retryAt: within }))).toBe(3);
  });

  it("lets no provider metadata make a non-idempotent mutation retryable", async () => {
    expect(await attemptsUntilFailure(classified({ retryable: true }), "mutation")).toBe(1);
  });

  it("lets no provider metadata override a policy that opted out", async () => {
    const off = reliability({ retry: { eligible: false, maxAttempts: 5, backoff: "fixed" } });
    expect(await attemptsUntilFailure(classified({ retryable: true }), "query", off)).toBe(1);
  });
});
