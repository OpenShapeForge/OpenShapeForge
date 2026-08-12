// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { dataErasureCoverageFailures } from "./data-erasure-coverage.mjs";

type TestTable = {
  schema: string;
  table: string;
  columns: Array<{ name: string; primaryKey?: boolean; classification?: string }>;
  retention?: {
    erasure?: {
      subjectScoped?: boolean;
      subjectColumns?: string[];
      cascades?: Array<{ schema: string; table: string; via: string }>;
    };
  };
};

function table(
  name: string,
  options: {
    classified?: boolean;
    subjectColumns?: string[];
    cascades?: Array<{ schema: string; table: string; via: string }>;
  } = {},
): TestTable {
  return {
    schema: "erp",
    table: name,
    columns: [
      { name: "id", primaryKey: true },
      { name: "relation_id" },
      ...(options.classified ? [{ name: "secret", classification: "pii" }] : []),
    ],
    ...(options.subjectColumns
      ? {
          retention: {
            erasure: {
              subjectScoped: true,
              subjectColumns: options.subjectColumns,
              ...(options.cascades ? { cascades: options.cascades } : {}),
            },
          },
        }
      : {}),
  };
}

function supportedPlan(...additionalTables: TestTable[]): TestTable[] {
  return [
    table("relations", {
      subjectColumns: ["id"],
      cascades: [
        { schema: "erp", table: "contact_details", via: "relation_id" },
        { schema: "erp", table: "payment_details", via: "relation_id" },
      ],
    }),
    table("contact_details", { subjectColumns: ["relation_id"] }),
    table("payment_details", { subjectColumns: ["relation_id"] }),
    ...additionalTables,
  ];
}

describe("generated data-erasure coverage", () => {
  test("fails closed when the generated manifest has no table catalog", () => {
    expect(dataErasureCoverageFailures({})).toEqual([
      "generated database manifest has no tables array",
    ]);
  });

  test("fails closed when the supported fixed root is missing", () => {
    expect(dataErasureCoverageFailures({ tables: [table("unrelated")] })).toEqual([
      "supported data-erasure root erp.relations is missing from the generated manifest",
    ]);
  });

  test("accepts classifications covered by the fixed root and supported cascades", () => {
    const tables = supportedPlan();
    tables[1]!.columns.push({ name: "secret", classification: "pii" });
    tables[2]!.columns.push({ name: "bank_secret", classification: "confidential" });
    expect(dataErasureCoverageFailures({ tables })).toEqual([]);
  });

  test("fails closed when a generated classified table has no erasure plan", () => {
    const failures = dataErasureCoverageFailures({
      tables: supportedPlan(table("new_subject_data", { classified: true })),
    });
    expect(failures).toEqual([
      "erp.new_subject_data carries restricting classification (secret:pii) but is not covered by the supported erp.relations procedure or one of its valid cascades",
    ]);
  });

  test("rejects a newly authored classified self-root with no fixed runtime", () => {
    const failures = dataErasureCoverageFailures({
      tables: supportedPlan(
        table("unsupported_subject", { classified: true, subjectColumns: ["id"] }),
      ),
    });
    expect(failures).toEqual([
      "erp.unsupported_subject carries restricting classification (secret:pii) but is not covered by the supported erp.relations procedure or one of its valid cascades",
    ]);
  });

  test("rejects a dependent plan that no root reaches", () => {
    const dependent = table("orphaned_subject_data", {
      classified: true,
      subjectColumns: ["relation_id"],
    });
    expect(
      dataErasureCoverageFailures({
        tables: supportedPlan(dependent),
      }),
    ).toHaveLength(1);
  });

  test("rejects a newly authored classified cascade that the fixed runtime does not execute", () => {
    const extra = table("unsupported_dependent", {
      classified: true,
      subjectColumns: ["relation_id"],
    });
    const tables = supportedPlan(extra);
    tables[0]!.retention!.erasure!.cascades!.push({
      schema: "erp",
      table: "unsupported_dependent",
      via: "relation_id",
    });
    expect(dataErasureCoverageFailures({ tables })).toEqual([
      "erp.unsupported_dependent carries restricting classification (secret:pii) but is not covered by the supported erp.relations procedure or one of its valid cascades",
    ]);
  });

  test("fails closed when the fixed root omits a supported runtime cascade", () => {
    const tables = supportedPlan();
    tables[0]!.retention!.erasure!.cascades = [
      { schema: "erp", table: "contact_details", via: "relation_id" },
    ];
    expect(dataErasureCoverageFailures({ tables })).toEqual([
      "supported erp.relations procedure is missing manifest cascade to erp.payment_details via relation_id",
    ]);
  });

  test("rejects a cascade whose subject column does not match its target plan", () => {
    const root = table("relations", {
      subjectColumns: ["id"],
      cascades: [
        { schema: "erp", table: "contact_details", via: "relation_id" },
        { schema: "erp", table: "payment_details", via: "relation_id" },
      ],
    });
    const dependent = table("contact_details", {
      classified: true,
      subjectColumns: ["other_subject_id"],
    });
    const payment = table("payment_details", { subjectColumns: ["relation_id"] });
    expect(dataErasureCoverageFailures({ tables: [root, dependent, payment] })).toHaveLength(2);
  });
});
