// SPDX-License-Identifier: BUSL-1.1
export type TemplateContentErrorCode =
  | "INVALID_VALUE"
  | "DUPLICATE"
  | "BLOCK_UNKNOWN"
  | "BLOCK_SCHEMA_UNSUPPORTED"
  | "BLOCK_NOT_ALLOWED"
  | "UNSUPPORTED_CHANNEL"
  | "UNSUPPORTED_LOCALE"
  | "MISSING_VARIABLE"
  | "DEPENDENCY_UNRESOLVED"
  | "DEPENDENCY_INVALID"
  | "TEMPLATE_CYCLE"
  | "CONTENT_LIMIT_EXCEEDED";

export class TemplateContentError extends Error {
  constructor(
    readonly code: TemplateContentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TemplateContentError";
  }
}

export function contentError(code: TemplateContentErrorCode, message: string): never {
  throw new TemplateContentError(code, message);
}
