// SPDX-License-Identifier: BUSL-1.1
/**
 * The database-refusal classifier: which database errors become readable
 * 4xx answers, with what code, and — the part that matters for safety — what
 * text is and is not forwarded.
 */
import { describe, expect, it } from "bun:test";
import {
  classifyDatabaseError,
  readDatabaseError,
  type DatabaseErrorTableContext,
} from "../database-refusals.js";
import { HttpError, toHttpError } from "../../rest/http-error.js";

/** A Bun `SQL` PostgresError as observed on the wire: SQLSTATE in `errno`. */
function postgresError(
  message: string,
  fields: {
    sqlstate: string;
    routine?: string;
    detail?: string;
    hint?: string;
    constraint?: string;
    table?: string;
  },
): Error {
  const error = new Error(message);
  error.name = "PostgresError";
  Object.assign(error, {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: fields.sqlstate,
    severity: "ERROR",
    ...(fields.routine ? { routine: fields.routine, where: "PL/pgSQL function guard() line 4 at RAISE" } : {}),
    ...(fields.detail ? { detail: fields.detail } : {}),
    ...(fields.hint ? { hint: fields.hint } : {}),
    ...(fields.constraint ? { constraint: fields.constraint } : {}),
    ...(fields.table ? { table: fields.table } : {}),
  });
  return error;
}

const RAISE = "exec_stmt_raise";

const FINDINGS: DatabaseErrorTableContext = {
  table: "findings",
  belongsTo: new Set(["assessment_id", "test_target_id"]),
  fieldName: (column) =>
    ({ assessment_id: "assessmentId", test_target_id: "testTargetId", title: "title", severity: "severity" })[column],
};

describe("readDatabaseError", () => {
  it("reads Bun SQL facts (SQLSTATE in errno)", () => {
    const facts = readDatabaseError(
      postgresError("x", { sqlstate: "P0001", routine: RAISE, hint: "h", detail: "d" }),
    );
    expect(facts).toEqual({
      sqlstate: "P0001",
      message: "x",
      routine: RAISE,
      detail: "d",
      hint: "h",
    });
  });

  it("reads postgres.js facts (SQLSTATE in code, *_name fields)", () => {
    const error = new Error("dup");
    error.name = "PostgresError";
    Object.assign(error, { code: "23505", constraint_name: "findings_slug_key", table_name: "findings" });
    expect(readDatabaseError(error)).toEqual({
      sqlstate: "23505",
      message: "dup",
      constraint: "findings_slug_key",
      table: "findings",
    });
  });

  it("ignores errors that are not database errors", () => {
    expect(readDatabaseError(new Error("boom"))).toBeUndefined();
    expect(readDatabaseError(new HttpError(400, "VALIDATION", "x"))).toBeUndefined();
    const notPostgres = Object.assign(new Error("x"), { errno: "P0001" });
    expect(readDatabaseError(notPostgres)).toBeUndefined();
  });
});

describe("a refusal RAISEd by a trigger or guard function", () => {
  it("P0001 becomes 409 OPERATION_REFUSED with the trigger's own message, detail and hint", () => {
    const refusal = classifyDatabaseError(
      postgresError("A finding cannot move from closed back to open.", {
        sqlstate: "P0001",
        routine: RAISE,
        detail: "Finding is closed since 2026-09-01.",
        hint: "Create a new finding instead.",
      }),
    );
    expect(refusal).toEqual({
      status: 409,
      code: "OPERATION_REFUSED",
      message: "A finding cannot move from closed back to open.",
      detail: "Finding is closed since 2026-09-01.",
      hint: "Create a new finding instead.",
    });
  });

  it("a raised foreign_key_violation keeps the guard's wording as REFERENCE_NOT_FOUND 404", () => {
    // The pentest tenant-consistency guard: identical text for absent and other-tenant.
    expect(
      classifyDatabaseError(
        postgresError("Referenced record is not available.", { sqlstate: "23503", routine: RAISE }),
        FINDINGS,
      ),
    ).toEqual({
      status: 404,
      code: "REFERENCE_NOT_FOUND",
      message: "Referenced record is not available.",
    });
  });

  it("a raised unique or check violation maps to ALREADY_EXISTS / VALIDATION", () => {
    expect(
      classifyDatabaseError(postgresError("Slug is taken.", { sqlstate: "23505", routine: RAISE })),
    ).toMatchObject({ status: 409, code: "ALREADY_EXISTS", message: "Slug is taken." });
    expect(
      classifyDatabaseError(
        postgresError("v2 quote approval policy is invalid", { sqlstate: "23514", routine: RAISE }),
      ),
    ).toMatchObject({ status: 422, code: "VALIDATION", message: "v2 quote approval policy is invalid" });
  });

  it("a raised insufficient_privilege is 403 FORBIDDEN with the guard's message", () => {
    expect(
      classifyDatabaseError(
        postgresError("Only the assessment lead may close it.", { sqlstate: "42501", routine: RAISE }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN", message: "Only the assessment lead may close it." });
  });

  it("an authored `CODE: reason` message picks its own code and the platform status for it", () => {
    expect(
      classifyDatabaseError(
        postgresError("NOT_PUBLISHABLE: The document has no current version.", {
          sqlstate: "P0001",
          routine: RAISE,
        }),
      ),
    ).toEqual({
      status: 400,
      code: "NOT_PUBLISHABLE",
      message: "The document has no current version.",
    });
    expect(
      classifyDatabaseError(
        postgresError("ASSESSMENT_LOCKED: The assessment is signed off.", { sqlstate: "P0001", routine: RAISE }),
      ),
    ).toMatchObject({ status: 409, code: "ASSESSMENT_LOCKED" });
  });

  it("a RAISE with an SQLSTATE outside the refusal set stays redacted", () => {
    // A routine signalling an internal condition (e.g. data_exception) is not a rule refusing.
    expect(
      classifyDatabaseError(postgresError("pgcrypto is required", { sqlstate: "22023", routine: RAISE })),
    ).toBeUndefined();
    expect(
      classifyDatabaseError(postgresError("internal", { sqlstate: "XX000", routine: RAISE })),
    ).toBeUndefined();
  });
});

describe("a system constraint violation", () => {
  it("child-side foreign key names the belongsTo field and never the constraint", () => {
    const refusal = classifyDatabaseError(
      postgresError(
        'insert or update on table "findings" violates foreign key constraint "findings_assessment_id_fkey"',
        {
          sqlstate: "23503",
          routine: "ri_ReportViolation",
          constraint: "findings_assessment_id_fkey",
          table: "findings",
          detail: 'Key (assessment_id)=(0b6c...) is not present in table "assessments".',
        },
      ),
      FINDINGS,
    );
    expect(refusal).toEqual({
      status: 404,
      code: "REFERENCE_NOT_FOUND",
      message: "assessmentId does not refer to a record that exists or is visible to you.",
    });
    expect(JSON.stringify(refusal)).not.toContain("fkey");
    expect(JSON.stringify(refusal)).not.toContain("assessment_id");
  });

  it("a foreign key on a column that is not a declared belongsTo stays generic", () => {
    expect(
      classifyDatabaseError(
        postgresError('insert or update on table "findings" violates foreign key constraint "findings_owner_id_fkey"', {
          sqlstate: "23503",
          constraint: "findings_owner_id_fkey",
        }),
        FINDINGS,
      ),
    ).toMatchObject({
      code: "REFERENCE_NOT_FOUND",
      message: "A referenced record does not exist or is not visible to you.",
    });
  });

  it("parent-side foreign key is REFERENCE_IN_USE 409", () => {
    expect(
      classifyDatabaseError(
        postgresError(
          'update or delete on table "assessments" violates foreign key constraint "findings_assessment_id_fkey" on table "findings"',
          { sqlstate: "23503", constraint: "findings_assessment_id_fkey", table: "findings" },
        ),
      ),
    ).toEqual({
      status: 409,
      code: "REFERENCE_IN_USE",
      message: "This record is still referenced by other records and cannot be removed.",
    });
  });

  it("unique violation names the field from the default or per-tenant index name", () => {
    expect(
      classifyDatabaseError(
        postgresError('duplicate key value violates unique constraint "findings_tenant_id_title_key"', {
          sqlstate: "23505",
          constraint: "findings_tenant_id_title_key",
          detail: "Key (tenant_id, title)=(t, Secret title) already exists.",
        }),
        FINDINGS,
      ),
    ).toEqual({ status: 409, code: "ALREADY_EXISTS", message: "A record with this title already exists." });
    expect(
      classifyDatabaseError(
        postgresError("duplicate key", { sqlstate: "23505", constraint: "findings_tenant_title_uidx" }),
        FINDINGS,
      ),
    ).toMatchObject({ message: "A record with this title already exists." });
    expect(
      classifyDatabaseError(postgresError("duplicate key", { sqlstate: "23505", constraint: "findings_pkey" })),
    ).toMatchObject({ code: "ALREADY_EXISTS", message: "A record with the same unique value already exists." });
  });

  it("check and not-null violations are 422 VALIDATION naming only exposed fields", () => {
    expect(
      classifyDatabaseError(
        postgresError('new row for relation "findings" violates check constraint "findings_severity_check"', {
          sqlstate: "23514",
          constraint: "findings_severity_check",
        }),
        FINDINGS,
      ),
    ).toEqual({ status: 422, code: "VALIDATION", message: "severity has a value this record does not allow." });
    expect(
      classifyDatabaseError(
        postgresError('null value in column "title" of relation "findings" violates not-null constraint', {
          sqlstate: "23502",
        }),
        FINDINGS,
      ),
    ).toEqual({ status: 422, code: "VALIDATION", message: "title is required." });
    expect(
      classifyDatabaseError(
        postgresError('null value in column "internal_marker" of relation "findings" violates not-null constraint', {
          sqlstate: "23502",
        }),
        FINDINGS,
      ),
    ).toMatchObject({ message: "A required value is missing." });
  });

  it("insufficient privilege and row-level security are 403 without the driver text", () => {
    const refusal = classifyDatabaseError(
      postgresError('new row violates row-level security policy for table "findings"', { sqlstate: "42501" }),
    );
    expect(refusal).toEqual({
      status: 403,
      code: "FORBIDDEN",
      message: "You do not have permission to perform this operation on this record.",
    });
  });

  it("never forwards a system message, detail or hint", () => {
    const system = [
      postgresError('insert or update on table "findings" violates foreign key constraint "x"', {
        sqlstate: "23503",
        detail: "Key (assessment_id)=(abc) is not present",
        hint: "system hint",
      }),
      postgresError('duplicate key value violates unique constraint "findings_pkey"', {
        sqlstate: "23505",
        detail: "Key (id)=(abc) already exists.",
      }),
      postgresError('permission denied for table findings', { sqlstate: "42501", hint: "grant it" }),
    ];
    for (const error of system) {
      const refusal = classifyDatabaseError(error, FINDINGS);
      expect(refusal).toBeDefined();
      const text = JSON.stringify(refusal);
      expect(refusal).not.toHaveProperty("detail");
      expect(refusal).not.toHaveProperty("hint");
      expect(text).not.toContain("findings");
      expect(text).not.toContain("abc");
      expect(text).not.toContain("Key (");
    }
  });
});

describe("errors that must stay redacted", () => {
  it("syntax, cast, timeout and connection errors classify to nothing", () => {
    for (const [message, sqlstate] of [
      ['syntax error at or near "SELEC"', "42601"],
      ['invalid input syntax for type uuid: "x"', "22P02"],
      ["canceling statement due to statement timeout", "57014"],
      ["division by zero", "22012"],
      ['relation "findings" does not exist', "42P01"],
    ] as const) {
      expect(classifyDatabaseError(postgresError(message, { sqlstate }))).toBeUndefined();
    }
  });

  it("toHttpError answers a redacted 500 for those, and the refusal for a rule", () => {
    expect(toHttpError(postgresError('syntax error at or near "SELEC"', { sqlstate: "42601" }))).toEqual({
      status: 500,
      body: { error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error." } },
    });
    expect(
      toHttpError(
        postgresError("Status cannot change once closed.", {
          sqlstate: "P0001",
          routine: RAISE,
          hint: "Reopen via the assessment lead.",
        }),
      ),
    ).toEqual({
      status: 409,
      body: {
        error: {
          code: "OPERATION_REFUSED",
          message: "Status cannot change once closed.",
          hint: "Reopen via the assessment lead.",
        },
      },
    });
  });
});
