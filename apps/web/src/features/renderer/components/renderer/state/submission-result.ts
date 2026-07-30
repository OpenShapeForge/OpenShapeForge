// SPDX-License-Identifier: BUSL-1.1
import { resolveIdRouteTemplate } from "@/lib/route-template";

export type RendererFormFieldErrors = Partial<Record<string, string>>;

export type RendererFormSubmissionResult = {
  fieldErrors?: RendererFormFieldErrors;
  formError?: string;
};

const DEFAULT_FORM_ERRORS = {
  en: "Something went wrong while saving the form.",
  nl: "Er is iets misgegaan bij het opslaan van het formulier.",
} as const;

/** Known English strings emitted by generated GraphQL resolvers — mirror for NL UI. */
const SERVER_REVIEW_FIELDS_EN = "Please review the highlighted fields and try again.";

export function isSubmissionResult(value: unknown): value is RendererFormSubmissionResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      ("fieldErrors" in value || "formError" in value),
  );
}

export function buildSuccessRoute(routeTemplate: string, id: string): string {
  return resolveIdRouteTemplate(routeTemplate, id);
}

export function getRendererSubmissionResultFromError(
  error: unknown,
  allowedFieldKeys: readonly string[],
  lang: string,
): RendererFormSubmissionResult {
  const { fieldErrors, supplementalMessages } = extractFieldErrorsWithSupplement(
    error,
    allowedFieldKeys,
  );
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;
  const supplementalText =
    supplementalMessages.length > 0 ? supplementalMessages.join(" ") : undefined;

  if (hasFieldErrors) {
    return supplementalText ? { fieldErrors, formError: supplementalText } : { fieldErrors };
  }

  if (supplementalText) {
    return { formError: supplementalText };
  }

  return {
    formError: getRendererFormErrorMessage(error, lang),
  };
}

export function getRendererFormErrorMessage(error: unknown, lang: string): string {
  if (lang === "nl" && error && typeof error === "object") {
    for (const graphQLError of getGraphQLErrors(error as Record<string, unknown>)) {
      const code = graphQLError.extensions?.databaseCode;
      if (typeof code === "string") {
        const nl = localizedDatabaseValidationMessage(code, "nl");
        if (nl) return nl;
      }
    }
  }

  const raw = getErrorMessage(error) || getDefaultRendererFormError(lang);
  return translateKnownServerMessages(raw, lang);
}

export function getDefaultRendererFormError(lang: string): string {
  return lang === "nl" ? DEFAULT_FORM_ERRORS.nl : DEFAULT_FORM_ERRORS.en;
}

function translateKnownServerMessages(message: string, lang: string): string {
  if (lang === "nl" && message === SERVER_REVIEW_FIELDS_EN) {
    return "Controleer de gemarkeerde velden en probeer het opnieuw.";
  }
  return message;
}

function localizedDatabaseValidationMessage(code: string, lang: string): string | undefined {
  if (lang !== "nl") {
    return undefined;
  }
  switch (code) {
    case "22P02":
      return "Een of meer waarden hebben een ongeldig formaat. Controleer gestructureerde velden zoals condities of JSON.";
    case "23502":
      return "Een verplichte waarde kon niet worden opgeslagen.";
    case "23514":
      return "Een waarde voldeed niet aan de validatieregels.";
    default:
      return undefined;
  }
}

function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (!error || typeof error !== "object") {
    return undefined;
  }

  const record = error as Record<string, unknown>;

  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }

  for (const graphQLError of getGraphQLErrors(record)) {
    if (graphQLError && typeof graphQLError.message === "string" && graphQLError.message.trim()) {
      return graphQLError.message.trim();
    }
  }

  if (
    record.networkError &&
    typeof record.networkError === "object" &&
    "message" in record.networkError &&
    typeof record.networkError.message === "string" &&
    record.networkError.message.trim()
  ) {
    return record.networkError.message.trim();
  }

  return undefined;
}

function normalizeFieldErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim()) as
      | string
      | undefined;
    return first?.trim();
  }
  return undefined;
}

/**
 * Maps GraphQL `extensions.fieldErrors` onto form leaf keys, and collects messages for keys
 * the form does not know about (so they still surface in the banner).
 */
function extractFieldErrorsWithSupplement(
  error: unknown,
  allowedFieldKeys: readonly string[],
): { fieldErrors: RendererFormFieldErrors; supplementalMessages: string[] } {
  const fieldErrors: RendererFormFieldErrors = {};
  const supplementalMessages: string[] = [];

  if (!error || typeof error !== "object") {
    return { fieldErrors, supplementalMessages };
  }

  const record = error as Record<string, unknown>;
  const sources: unknown[] = [error];

  for (const graphQLError of getGraphQLErrors(record)) {
    sources.push(graphQLError);
    if (graphQLError.extensions) {
      sources.push(graphQLError.extensions);
    }
  }

  for (const source of sources) {
    mergeFieldErrors(fieldErrors, source, allowedFieldKeys);
  }

  for (const graphQLError of getGraphQLErrors(record)) {
    const raw = graphQLError.extensions?.fieldErrors;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }

    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      const msg = normalizeFieldErrorMessage(val);
      if (!msg) {
        continue;
      }
      if (allowedFieldKeys.includes(key)) {
        if (!fieldErrors[key]) {
          fieldErrors[key] = msg;
        }
      } else {
        supplementalMessages.push(msg);
      }
    }
  }

  return { fieldErrors, supplementalMessages };
}

function mergeFieldErrors(
  target: RendererFormFieldErrors,
  source: unknown,
  allowedFieldKeys: readonly string[],
) {
  if (!source || typeof source !== "object") {
    return;
  }

  const record = source as Record<string, unknown>;
  const directFieldErrors = readFieldErrorRecord(record.fieldErrors, allowedFieldKeys);
  if (directFieldErrors) {
    Object.assign(target, directFieldErrors);
  }

  for (const candidate of [record.validationErrors, record.errors, record.fieldViolations]) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    for (const item of candidate) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const itemRecord = item as Record<string, unknown>;
      const field =
        typeof itemRecord.field === "string"
          ? itemRecord.field
          : typeof itemRecord.path === "string"
            ? itemRecord.path
            : undefined;
      const message =
        typeof itemRecord.message === "string" && itemRecord.message.trim()
          ? itemRecord.message.trim()
          : undefined;

      if (field && message && allowedFieldKeys.includes(field)) {
        target[field] = message;
      }
    }
  }
}

function readFieldErrorRecord(
  value: unknown,
  allowedFieldKeys: readonly string[],
): RendererFormFieldErrors | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result: RendererFormFieldErrors = {};
  for (const [fieldKey, fieldValue] of Object.entries(value)) {
    if (!allowedFieldKeys.includes(fieldKey)) {
      continue;
    }

    if (typeof fieldValue === "string" && fieldValue.trim()) {
      result[fieldKey] = fieldValue.trim();
      continue;
    }

    if (Array.isArray(fieldValue)) {
      const firstMessage = fieldValue.find(
        (item) => typeof item === "string" && item.trim(),
      ) as string | undefined;
      if (firstMessage) {
        result[fieldKey] = firstMessage.trim();
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function getGraphQLErrors(
  record: Record<string, unknown>,
): Array<{ message?: unknown; extensions?: Record<string, unknown> }> {
  if (!Array.isArray(record.graphQLErrors)) {
    return [];
  }

  return record.graphQLErrors.filter(
    (item): item is { message?: unknown; extensions?: Record<string, unknown> } =>
      Boolean(item) && typeof item === "object",
  );
}
