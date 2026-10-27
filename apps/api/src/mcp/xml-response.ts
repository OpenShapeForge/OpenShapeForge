// SPDX-License-Identifier: BUSL-1.1
/**
 * XML provider responses, read into the same JSON shape the response mapping
 * already interprets. Older provider APIs (ASMX web services, among others)
 * answer only in XML; converting once at the boundary keeps rootPath,
 * fieldPaths and transforms the single mapping vocabulary.
 *
 * Fixed rules, not configuration:
 *   - Values stay strings. Ledger codes such as "0100" and identifiers that
 *     look numeric must survive the trip; typing is the mapping's job.
 *   - Namespace prefixes and xmlns declarations are dropped, so paths name
 *     elements as a person reads them.
 *   - Attributes surface under an "@" prefix; mixed text under "#text".
 *   - A document type declaration is refused outright: a provider response
 *     has no use for one, and refusing it closes entity expansion entirely.
 *   - Which elements are collections is authored (`arrays`), never guessed —
 *     a list that happens to hold one item must still map as a list.
 */
import { XMLParser } from "fast-xml-parser";

export class XmlResponseError extends Error {}

const DOCTYPE = /<!DOCTYPE/i;

/** Element paths (dot-joined from the root) that always parse as arrays. */
export function xmlArrayPaths(responseMapping: unknown): ReadonlySet<string> {
  const xml =
    responseMapping && typeof responseMapping === "object"
      ? (responseMapping as { xml?: unknown }).xml
      : undefined;
  const arrays =
    xml && typeof xml === "object" ? (xml as { arrays?: unknown }).arrays : undefined;
  return new Set(
    Array.isArray(arrays)
      ? arrays.filter((path): path is string => typeof path === "string" && path.length > 0)
      : [],
  );
}

export function parseXmlResponse(
  text: string,
  arrays: ReadonlySet<string> = new Set(),
): unknown {
  if (DOCTYPE.test(text)) {
    throw new XmlResponseError("The XML response declares a document type.");
  }
  const parser = new XMLParser({
    ignoreAttributes: ["xmlns", /^xmlns:/],
    attributeNamePrefix: "@",
    textNodeName: "#text",
    removeNSPrefix: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: true,
    htmlEntities: false,
    isArray: (_name, jPath) => arrays.has(String(jPath)),
  });
  try {
    return parser.parse(text, true);
  } catch (error) {
    throw new XmlResponseError(
      error instanceof Error ? error.message : "The XML response is not well-formed.",
    );
  }
}
