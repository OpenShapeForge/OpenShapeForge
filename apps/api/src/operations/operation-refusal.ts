// SPDX-License-Identifier: BUSL-1.1
/** Trusted refusal carrying an explicit status for interface projections. */
export class OperationRefusal extends Error {
  readonly status: number;
  readonly code: string;
  /** Authored detail/hint carried along when the error relays a database rule's refusal. */
  readonly detail: string | undefined;
  readonly hint: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    authored?: { detail?: string; hint?: string },
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = authored?.detail;
    this.hint = authored?.hint;
  }
}
