// SPDX-License-Identifier: BUSL-1.1
import {
  createCounter,
  createHistogram,
  usePrometheus,
} from "@graphql-yoga/plugin-prometheus";
import { GraphQLError } from "graphql";
import {
  maskError as yogaMaskError,
  type CORSOptions,
  type Plugin,
  type YogaMaskedErrorOpts,
} from "graphql-yoga";
import type { Registry } from "prom-client";
import {
  boundedLabel,
  sanitizeError,
  type SanitizedErrorReport,
} from "./redaction.js";
import {
  getProcessPrometheusRegistry,
  getProcessYogaMetricsPlugins,
} from "./registry.js";

const OPERATION_TYPES = new Set(["query", "mutation", "subscription"]);
const ERROR_PHASES = new Set([
  "parse",
  "validate",
  "context",
  "execute",
  "subscribe",
]);

export type FixedCorsPolicy = Exclude<CORSOptions, false> & {
  origin: string | string[];
};

export type GraphqlCorsPolicy =
  | false
  | FixedCorsPolicy
  | ((
      request: Request,
    ) => FixedCorsPolicy | false | Promise<FixedCorsPolicy | false>);

function validOrigin(origin: string): boolean {
  if (origin === "null" || origin.includes("*")) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      parsed.origin === origin
    );
  } catch {
    return false;
  }
}

export function validateCorsPolicy(
  policy: FixedCorsPolicy | false,
): CORSOptions {
  if (policy === false) return false;
  const origins = Array.isArray(policy.origin)
    ? policy.origin
    : [policy.origin];
  if (origins.length === 0 || origins.some((origin) => !validOrigin(origin))) {
    throw new Error(
      "CORS origins must be non-empty exact HTTP(S) origins without wildcards.",
    );
  }
  if (new Set(origins).size !== origins.length) {
    throw new Error("CORS origins must not contain duplicates.");
  }
  return {
    ...policy,
    origin: [...origins],
    methods: [...(policy.methods ?? ["GET", "POST", "OPTIONS"])],
    allowedHeaders: [
      ...(policy.allowedHeaders ?? ["content-type", "authorization"]),
    ],
    credentials: policy.credentials ?? false,
  };
}

/** Convert an explicit host policy to Yoga configuration; absence is impossible. */
export function createYogaCorsConfiguration(policy: GraphqlCorsPolicy) {
  const forRequest = (request: Request, candidate: FixedCorsPolicy | false) => {
    const validated = validateCorsPolicy(candidate);
    if (validated === false) return false;
    const requestOrigin = request.headers.get("origin");
    if (!requestOrigin) return validated;
    const origins = Array.isArray(validated.origin)
      ? validated.origin
      : [validated.origin];
    if (!origins.includes(requestOrigin)) return false;
    return { ...validated, origin: requestOrigin };
  };
  if (typeof policy !== "function") {
    const validated = validateCorsPolicy(policy);
    return (request: Request) => {
      if (validated === false) return false;
      const requestOrigin = request.headers.get("origin");
      if (!requestOrigin) return validated;
      const origins = Array.isArray(validated.origin)
        ? validated.origin
        : [validated.origin];
      return origins.includes(requestOrigin)
        ? { ...validated, origin: requestOrigin }
        : false;
    };
  }
  return async (request: Request): Promise<CORSOptions> =>
    forRequest(request, await policy(request));
}

type OperationParams = {
  operationName?: string;
  operationType?: string;
  errorPhase?: string;
  error?: unknown;
};

type HttpOperationParams = OperationParams & { response: Response };

function operationLabels(
  params: OperationParams,
  allowed: ReadonlySet<string>,
) {
  return {
    operation_name: boundedLabel(
      params.operationName,
      allowed,
      params.operationName ? "Other" : "Anonymous",
    ),
    operation_type: OPERATION_TYPES.has(params.operationType ?? "")
      ? params.operationType!
      : "unknown",
  };
}

function isExpectedGraphqlError(error: unknown): boolean {
  if (!(error instanceof GraphQLError)) return false;
  return !error.originalError || error.originalError instanceof GraphQLError;
}

export type YogaMetricsOptions = {
  allowedOperationNames: ReadonlySet<string>;
  metricPrefix: string;
  registry?: Registry;
};

/** Official Yoga/Envelop Prometheus phases with an intentionally small label set. */
export function createYogaMetricsPlugin(options: YogaMetricsOptions): Plugin {
  const registry = options.registry ?? getProcessPrometheusRegistry();
  if (!/^[a-z][a-z0-9_]*$/.test(options.metricPrefix)) {
    throw new Error("Prometheus metricPrefix must be lower snake case.");
  }
  const fingerprint = JSON.stringify([
    options.metricPrefix,
    [...options.allowedOperationNames].sort(),
  ]);
  const metricsPlugins = getProcessYogaMetricsPlugins();
  const cached = metricsPlugins.get(registry);
  if (cached) {
    if (cached.fingerprint !== fingerprint) {
      throw new Error(
        "A Prometheus registry cannot be reused with different Yoga metric policy.",
      );
    }
    return cached.plugin as Plugin;
  }
  const metricName = (suffix: string) => `${options.metricPrefix}_${suffix}`;
  const labels = (params: OperationParams) =>
    operationLabels(params, options.allowedOperationNames);
  const duration = <TPhase extends string>(
    name: string,
    help: string,
    phases: [TPhase, ...TPhase[]],
  ) =>
    createHistogram<
      TPhase,
      "operation_name" | "operation_type",
      OperationParams
    >({
      registry,
      histogram: {
        name,
        help,
        labelNames: ["operation_name", "operation_type"] as const,
        buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      },
      fillLabelsFn: labels,
      phases,
    });
  const plugin = usePrometheus({
    registry,
    endpoint: false,
    skipIntrospection: true,
    labels: {
      // Keep only these two source attributes so the custom factories can
      // map them to the bounded label vocabulary below.
      operationName: true,
      operationType: true,
      fieldName: false,
      typeName: false,
      returnType: false,
      path: false,
      phase: false,
      method: false,
      statusCode: false,
      url: false,
    },
    metrics: {
      graphql_envelop_request: createCounter({
        registry,
        counter: {
          name: metricName("graphql_operations_total"),
          help: "GraphQL operations reaching execution.",
          labelNames: ["operation_name", "operation_type"] as const,
        },
        fillLabelsFn: labels,
      }),
      graphql_envelop_request_duration: duration(
        metricName("graphql_operation_duration_seconds"),
        "GraphQL execution duration in seconds.",
        ["execute"],
      ),
      graphql_envelop_phase_parse: duration(
        metricName("graphql_parse_duration_seconds"),
        "GraphQL parse duration in seconds.",
        ["parse"],
      ),
      graphql_envelop_phase_validate: duration(
        metricName("graphql_validate_duration_seconds"),
        "GraphQL validation duration in seconds.",
        ["validate"],
      ),
      graphql_envelop_phase_execute: duration(
        metricName("graphql_execute_duration_seconds"),
        "GraphQL execute duration in seconds.",
        ["execute"],
      ),
      graphql_envelop_error_result: createCounter({
        registry,
        counter: {
          name: metricName("graphql_errors_total"),
          help: "GraphQL errors by bounded operation, phase, and classification.",
          labelNames: [
            "operation_name",
            "operation_type",
            "phase",
            "classification",
          ] as const,
        },
        fillLabelsFn: (params: OperationParams) => ({
          ...labels(params),
          phase: ERROR_PHASES.has(params.errorPhase ?? "")
            ? params.errorPhase!
            : "unknown",
          classification:
            params.errorPhase === "parse" ||
            params.errorPhase === "validate" ||
            isExpectedGraphqlError(params.error)
              ? "expected"
              : "unexpected",
        }),
      }),
      graphql_envelop_request_time_summary: false,
      graphql_envelop_phase_context: false,
      graphql_envelop_phase_subscribe: false,
      graphql_envelop_deprecated_field: false,
      graphql_envelop_execute_resolver: false,
      graphql_envelop_schema_change: false,
      graphql_yoga_http_duration: createHistogram<
        "request",
        "operation_name" | "operation_type" | "status_code",
        HttpOperationParams
      >({
        registry,
        histogram: {
          name: metricName("graphql_http_duration_seconds"),
          help: "GraphQL HTTP request duration in seconds.",
          labelNames: [
            "operation_name",
            "operation_type",
            "status_code",
          ] as const,
          buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
        },
        fillLabelsFn: (params) => ({
          ...labels(params),
          status_code: String(params.response.status),
        }),
        phases: ["request"],
      }),
    },
  });
  metricsPlugins.set(registry, { fingerprint, plugin });
  return plugin;
}

export type UnexpectedErrorOptions = {
  report(error: SanitizedErrorReport): void;
};

/** Preserve Yoga masking and report each unexpected exception once, already redacted. */
export function createMaskedErrorOptions(
  options: UnexpectedErrorOptions,
): Partial<YogaMaskedErrorOpts> {
  const reported = new WeakSet<object>();
  return {
    isDev: false,
    maskError(error, message, isDev) {
      if (!isExpectedGraphqlError(error)) {
        const identity = error && typeof error === "object" ? error : null;
        if (!identity || !reported.has(identity)) {
          if (identity) reported.add(identity);
          const original =
            error instanceof GraphQLError && error.originalError
              ? error.originalError
              : error;
          options.report(sanitizeError(original, "graphql.unexpected"));
        }
      }
      return yogaMaskError(error, message, isDev);
    },
  };
}
