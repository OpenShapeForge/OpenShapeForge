// SPDX-License-Identifier: BUSL-1.1
/** Input shape checks shared by the documents handlers; every failure is a canonical Operation error. */
import { operationFailure } from "@openshapeforge/operations";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function refuse(code: string, message: string): never {
  throw operationFailure({ code, message, retryable: false });
}
export function object(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value)) refuse("VALIDATION", `${name} must be an object.`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) refuse("VALIDATION", `${name} is required.`);
  return value as string;
}
export function uuid(value: unknown, name: string): string {
  const id = text(value, name);
  if (!UUID.test(id)) refuse("VALIDATION", `${name} must be a UUID.`);
  return id;
}
