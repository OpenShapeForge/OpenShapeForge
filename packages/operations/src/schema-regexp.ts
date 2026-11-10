// SPDX-License-Identifier: BUSL-1.1
import { RE2JS } from "re2js";

/** One pattern dialect for authored fields and their canonical Operation schemas.
 * RE2 matching is linear in the value length; unsupported backreferences and
 * lookarounds are rejected, never retried through the native backtracking VM.
 * Bound the compiled program too: a short repeated alternation can expand.
 */
export const SCHEMA_PATTERN_MAX_LENGTH = 4096;
export const SCHEMA_PATTERN_MAX_PROGRAM_SIZE = 16384;

export const schemaRegExp = Object.assign((pattern: string, flags = "u") => {
  try {
    if (pattern.length > SCHEMA_PATTERN_MAX_LENGTH || (flags !== "u" && flags !== "")) throw new Error();
    const compiled = RE2JS.compile(RE2JS.translateRegExp(pattern));
    if (compiled.programSize() > SCHEMA_PATTERN_MAX_PROGRAM_SIZE) throw new Error();
    return {
      test: (value: string) => compiled.test(value),
      // Ajv interns regex instances by toString(), including its meta-schemas.
      toString: () => JSON.stringify([pattern, flags]),
    };
  } catch {
    // Tenant-authored patterns must not leak through compiler errors/logs.
    throw new Error("Validation pattern is unsupported or exceeds the schema complexity limit.");
  }
}, { code: 'require("@openshapeforge/operations").schemaRegExp' });
