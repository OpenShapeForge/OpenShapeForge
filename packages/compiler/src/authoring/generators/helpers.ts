// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * EJS template rendering helper and shared utility functions used by all generators.
 *
 * Provides renderTemplate() which loads an EJS template from the templates directory
 * and renders it with the given data plus a standard helpers object. The helpers object
 * contains SQL/TS/GQL type mapping functions and string transformation utilities
 * (capitalize, uncapitalize, pascalToSnake) used across templates and generators.
 *
 * Template directory resolution: prefers source templates during development,
 * falls back to compiled runtime templates in production builds.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ejs from "ejs";

const runtimeTemplatesDir = join(dirname(fileURLToPath(import.meta.url)), "templates");
const sourceTemplatesDir = resolve(process.cwd(), "src/generators/templates");
const TEMPLATES_DIR = existsSync(sourceTemplatesDir) ? sourceTemplatesDir : runtimeTemplatesDir;

export function renderTemplate(
  templatePath: string,
  data: Record<string, unknown>
): string {
  const fullPath = join(TEMPLATES_DIR, templatePath);
  const template = readFileSync(fullPath, "utf-8");
  return ejs.render(template, { ...data, helpers }, { filename: fullPath });
}

export const helpers = {
  sqlType(type: string): string {
    const map: Record<string, string> = {
      uuid: "UUID", text: "TEXT", integer: "INTEGER",
      numeric: "NUMERIC", boolean: "BOOLEAN", date: "DATE",
      timestamptz: "TIMESTAMPTZ", jsonb: "JSONB",
    };
    return map[type] ?? "TEXT";
  },

  sqlToTsType(type: string): string {
    const map: Record<string, string> = {
      uuid: "string", text: "string", integer: "number",
      numeric: "number", boolean: "boolean", date: "string",
      timestamptz: "Date", jsonb: "unknown",
    };
    return map[type] ?? "string";
  },

  fieldToTsType(type: string): string {
    const map: Record<string, string> = {
      uuid: "string", string: "string", reference: "string",
      integer: "number", number: "number", boolean: "boolean",
      date: "Date", datetime: "Date", object: "unknown", array: "unknown[]", fieldArray: "unknown[]",
    };
    return map[type] ?? "string";
  },

  gqlTypeToTs(gqlType: string): string {
    const base = gqlType.replace("!", "");
    const map: Record<string, string> = {
      ID: "string", String: "string", Referentiedata: "string",
      Int: "number", Float: "number", Boolean: "boolean", JSON: "unknown",
    };
    return map[base] ?? "string";
  },

  capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  },

  uncapitalize(s: string): string {
    return s.charAt(0).toLowerCase() + s.slice(1);
  },

  pascalToSnake(s: string): string {
    const snake = s.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
    if (snake.endsWith("s") || snake.endsWith("sh") || snake.endsWith("ch") || snake.endsWith("x") || snake.endsWith("z")) return snake + "es";
    if (snake.endsWith("y") && !["ay", "ey", "iy", "oy", "uy"].some((v) => snake.endsWith(v))) return snake.slice(0, -1) + "ies";
    return snake + "s";
  },
};
