// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isOperationFailure,
  operationErrorOf,
  operationFailure,
  OperationFailure,
  type OperationConfirmation,
  type OperationConcurrency,
  type OperationOffer,
  type OperationResult,
} from "./index.js";

test("a challenge is server-issued, version-bound and single-use", () => {
  const confirmation = {
    mode: "challenge",
    challenge: {
      kind: "type-current-field",
      field: "displayName",
      issuedBy: "server",
      bindTo: ["subject", "tenant", "operation", "target.id", "target.version"],
      expiresAfter: "PT5M",
      singleUse: true,
    },
  } satisfies OperationConfirmation;

  expect(confirmation.challenge.bindTo).toContain("target.version");
});

test("an available offer can carry a server-issued transport-neutral interaction", () => {
  const offer = {
    operation: { id: "workflow.interaction.respond", intent: "respond" },
    available: true,
    interaction: {
      kind: "userInput",
      offerId: "opaque-server-offer",
      choices: [{ value: "approve", label: "Approve" }],
      expiresAt: "2026-09-12T12:00:00.000Z",
      bindTo: {
        tenant: "tenant-1",
        subject: "user-1",
        instance: "workflow-1",
        node: "approval",
        version: "3",
      },
    },
  } satisfies OperationOffer<"respond">;

  expect(offer.interaction.bindTo).toMatchObject({
    tenant: "tenant-1",
    subject: "user-1",
    instance: "workflow-1",
  });
});

test("a visible unavailable interaction choice carries a canonical reason", () => {
  const offer = {
    operation: { id: "workflow.interaction.respond", intent: "respond" },
    available: true,
    interaction: {
      kind: "userInput",
      offerId: "opaque-server-offer",
      choices: [{
        value: "approve",
        label: "Approve",
        available: false,
        error: {
          code: "CHOICE_DISABLED",
          message: "Approval is unavailable until the review is complete.",
          retryable: false,
        },
      }],
      expiresAt: "2026-09-12T12:00:00.000Z",
      bindTo: { tenant: "tenant-1", subject: "user-1" },
    },
  } satisfies OperationOffer<"respond">;

  expect(offer.interaction.choices[0]!.error.message).toContain("review");
});

test("an acknowledgement is distinct from server-issued proof", () => {
  const confirmation = {
    mode: "acknowledgement",
  } satisfies OperationConfirmation;

  expect(confirmation).toEqual({ mode: "acknowledgement" });
});

test("concurrency declares version and edit-lease requirements without interface details", () => {
  const concurrency = {
    version: { mode: "required", field: "updatedAt" },
    editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
  } satisfies OperationConcurrency;

  expect(concurrency).toEqual({
    version: { mode: "required", field: "updatedAt" },
    editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
  });
});

test("an available offer carries the same canonical lease timing", () => {
  const offer = {
    operation: { id: "Relation.update", intent: "update" },
    available: true,
    concurrency: {
      version: { mode: "required", field: "updatedAt" },
      editLease: { mode: "required", expiresAfterInactivity: "PT2M" },
    },
  } satisfies OperationOffer<"update">;

  expect(offer.concurrency.editLease.expiresAfterInactivity).toBe("PT2M");
});

test("validation and temporary refusals use one canonical failure contract", () => {
  const result: OperationResult<never> = {
    error: {
      code: "VALIDATION",
      message: "Check the entered values.",
      violations: [
        { field: "email", code: "INVALID_EMAIL", message: "Enter a valid email address." },
      ],
      retryable: false,
    },
  };

  expect(isOperationFailure(result)).toBe(true);
});

test("OperationFailure carries only interface-neutral failure meaning", () => {
  const failure = operationFailure({
    code: "LOCKED",
    message: "This record is currently being edited.",
    retryable: true,
    retryAt: "2026-09-11T15:15:00.000Z",
  });

  expect(operationErrorOf(failure)).toEqual({
    code: "LOCKED",
    message: "This record is currently being edited.",
    retryable: true,
    retryAt: "2026-09-11T15:15:00.000Z",
  });
});

test("canonical failures survive separately loaded package copies in both directions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "osf-operation-copy-"));
  try {
    const target = join(directory, "contract.ts");
    await copyFile(new URL("./contract.ts", import.meta.url), target);
    const other = await import(pathToFileURL(target).href);
    const meaning = { code: "ALREADY_EXISTS", message: "This version already exists.", retryable: false };
    const foreign = other.operationFailure(meaning);
    expect(foreign instanceof OperationFailure).toBe(false);
    expect(operationErrorOf(foreign)).toEqual(meaning);
    expect(other.operationErrorOf(operationFailure(meaning))).toEqual(meaning);
    expect(Object.keys(foreign)).not.toContain("openshapeforge.OperationFailure.v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plain errors and JSON-shaped failures never acquire canonical authority", () => {
  const meaning = { code: "FORBIDDEN", message: "Private driver detail", retryable: false };
  expect(operationErrorOf({ name: "OperationFailure", operationError: meaning })).toBeUndefined();
  const unbranded = Object.assign(new Error("Private driver detail"), { name: "OperationFailure", operationError: meaning });
  expect(operationErrorOf(unbranded)).toBeUndefined();
  const malformed = new Error("Invalid branded value");
  Object.defineProperty(malformed, Symbol.for("openshapeforge.OperationFailure.v1"), { value: true });
  Object.defineProperty(malformed, "operationError", { value: { code: 1, message: "invalid" } });
  expect(operationErrorOf(malformed)).toBeUndefined();
});
