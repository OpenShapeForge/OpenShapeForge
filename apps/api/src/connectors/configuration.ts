// SPDX-License-Identifier: BUSL-1.1
/**
 * Connector configuration validation and secret separation.
 *
 * A submitted configuration is validated against the compiled contract's
 * generated schema — the same schema the configuration form is rendered from,
 * so what a tenant is shown and what the write path accepts cannot diverge.
 *
 * Validation is strict, matching the generated REST surface: an unknown key is
 * a `400`, not something to drop silently. Silently dropping is how a
 * misspelled `endpoin:` ends up as a connector that points somewhere else than
 * the operator believes.
 *
 * Secret-marked values never enter the installation row. They are split out
 * here, at the boundary, so no code path further in has to remember: the
 * non-secret half goes to `config jsonb`, the secret half to the encrypted
 * per-field table.
 */
import { Ajv, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { SECRET_SET_SENTINEL } from "./secrets.js";

export type ConfigurationContract = {
  slug: string;
  configuration: {
    fields: { key: string; secret?: boolean }[];
    secretFields: string[];
    schema: Record<string, unknown>;
  };
};

export class ConnectorConfigurationError extends Error {
  readonly code = "CONNECTOR_INVALID_CONFIGURATION";
  constructor(message: string) {
    super(message);
    this.name = "ConnectorConfigurationError";
  }
}

export type SplitConfiguration = {
  /** Non-secret values, stored on the installation row. */
  config: Record<string, unknown>;
  /** Secret values to encrypt, keyed by field. Absent keys are left untouched. */
  secrets: Record<string, string>;
  /** Secret fields the caller explicitly left as "already set". */
  unchangedSecrets: string[];
};

function createAjv(): Ajv {
  const ajv = new Ajv2020.default({ allErrors: true, strict: false });
  // ajv-formats is CJS; under NodeNext the default import is typed as the
  // module namespace rather than the callable it is at runtime.
  (addFormats as unknown as (instance: Ajv) => unknown)(ajv);
  return ajv;
}

/**
 * Errors name the path and the rule, never the value — a configuration payload
 * is mostly credentials, and this message reaches logs and clients.
 */
function describeErrors(validate: ValidateFunction): string {
  const errors = validate.errors ?? [];
  if (errors.length === 0) return "configuration is invalid";
  return errors
    .map((error) => {
      const path = error.instancePath === "" ? "(root)" : error.instancePath;
      if (
        (error.keyword === "additionalProperties" ||
          error.keyword === "unevaluatedProperties") &&
        typeof (error.params?.additionalProperty ?? error.params?.unevaluatedProperty) ===
          "string"
      ) {
        const property =
          error.params.additionalProperty ?? error.params.unevaluatedProperty;
        return `unknown field "${property}"`;
      }
      return `${path} ${error.message ?? "is invalid"}`;
    })
    .sort()
    .join("; ");
}

export class ConnectorConfigurationValidator {
  private readonly validate: ValidateFunction;
  private readonly secretFields: ReadonlySet<string>;

  constructor(private readonly contract: ConfigurationContract) {
    this.validate = createAjv().compile(contract.configuration.schema);
    this.secretFields = new Set(contract.configuration.secretFields);
  }

  /**
   * Validate a submitted configuration and split it into the non-secret half
   * and the secrets to encrypt.
   *
   * A secret field submitted as the "already set" sentinel is left alone rather
   * than overwritten — that is what lets a UI round-trip a form without asking
   * the operator to retype every credential, and without the sentinel itself
   * being stored as the value.
   */
  parse(submitted: unknown): SplitConfiguration {
    if (submitted === null || typeof submitted !== "object" || Array.isArray(submitted)) {
      throw new ConnectorConfigurationError(
        `Configuration for "${this.contract.slug}" must be an object.`,
      );
    }

    const input = { ...(submitted as Record<string, unknown>) };
    const unchangedSecrets: string[] = [];

    // The sentinel is not a value the schema should ever see: it is a marker
    // meaning "keep what is stored". Strip it before validation so a field with
    // a pattern does not reject its own placeholder.
    for (const field of this.secretFields) {
      if (input[field] === SECRET_SET_SENTINEL) {
        delete input[field];
        unchangedSecrets.push(field);
      }
    }

    if (!this.validate(input)) {
      throw new ConnectorConfigurationError(
        `Configuration for "${this.contract.slug}" is invalid: ${describeErrors(this.validate)}.`,
      );
    }

    const config: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!this.secretFields.has(key)) {
        config[key] = value;
        continue;
      }
      if (typeof value !== "string") {
        throw new ConnectorConfigurationError(
          `Secret field "${key}" must be a string.`,
        );
      }
      secrets[key] = value;
    }

    return { config, secrets, unchangedSecrets: unchangedSecrets.sort() };
  }

  /**
   * Whether every required secret has a value once the submission is applied.
   *
   * Checked separately from schema validation because a secret's presence lives
   * in another table: the schema cannot see that `apiKey` is already stored.
   */
  missingSecrets(
    split: SplitConfiguration,
    alreadyStored: ReadonlySet<string>,
    requiredSecretFields: readonly string[],
  ): string[] {
    return requiredSecretFields
      .filter(
        (field) =>
          split.secrets[field] === undefined &&
          !split.unchangedSecrets.includes(field) &&
          !alreadyStored.has(field),
      )
      .sort();
  }
}
