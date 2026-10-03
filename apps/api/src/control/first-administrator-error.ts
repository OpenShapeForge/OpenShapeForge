// SPDX-License-Identifier: BUSL-1.1
/** A refusal from the platform invitation services, in a leaf module so helpers can throw it without an import cycle. */
export class FirstAdministratorError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
