// SPDX-License-Identifier: BUSL-1.1
/**
 * The seam between the graph adapter and the render layer.
 *
 * Most of this module derives rather than maps, and derivation cannot drift —
 * so the cases worth pinning are the two places it does map. The icon table is
 * a second description of a node type, and the tone reads a free-text field
 * that has already been inconsistent about capitalisation once, in a way that
 * put one trigger in a palette bucket of its own.
 *
 * The totality test is the important one: it fails when a node type is added to
 * the authoring YAML and nobody adds an icon, which is the only signal that
 * drift ever produces.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/__tests__/presentation.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  iconMappedNodeTypes,
  resolveWorkflowNodePresentation,
} from "../presentation.js";

const AUTHORING_DIR = resolve(
  import.meta.dir,
  "../../authoring/workflow-nodes",
);

/** Every node type the standard catalog authors, read from the YAML itself. */
function authoredNodeTypes(): string[] {
  const types: string[] = [];
  for (const family of readdirSync(AUTHORING_DIR, { withFileTypes: true })) {
    if (!family.isDirectory()) continue;
    for (const file of readdirSync(join(AUTHORING_DIR, family.name))) {
      if (!file.endsWith(".yaml")) continue;
      const source = readFileSync(join(AUTHORING_DIR, family.name, file), "utf8");
      const match = source.match(/^nodeType:\s*(\S+)\s*$/m);
      if (match?.[1]) types.push(match[1]);
    }
  }
  return types.sort();
}

describe("resolveWorkflowNodePresentation", () => {
  test("every authored standard node type has an icon", () => {
    // The drift guard. Adding a node type to the authoring YAML without adding
    // an icon here renders it as the fallback, and nothing else would say so.
    expect(iconMappedNodeTypes()).toEqual(authoredNodeTypes());
  });

  test("an unmapped node type falls back rather than failing to render", () => {
    // A domain pack's node, or one a host repo added. A card drawn plainly is a
    // better answer than a card that throws.
    const presentation = resolveWorkflowNodePresentation({ nodeType: "message.reply" });
    expect(presentation.iconName).toBe("circle");
    expect(presentation.typeLabel).toBe("message.reply");
  });

  test("trigger and terminal come from the type, not from the catalog", () => {
    // Asserted with NO catalog entry, because these decide whether a card draws
    // an incoming or outgoing connector — a node the catalog has not been
    // hydrated with must still be drawn with the right ports.
    expect(resolveWorkflowNodePresentation({ nodeType: "triggerWebhook" }).isTrigger).toBe(true);
    expect(resolveWorkflowNodePresentation({ nodeType: "triggerWebhook" }).isTerminal).toBe(false);
    expect(resolveWorkflowNodePresentation({ nodeType: "end" }).isTerminal).toBe(true);
    expect(resolveWorkflowNodePresentation({ nodeType: "end" }).isTrigger).toBe(false);
    expect(resolveWorkflowNodePresentation({ nodeType: "decision" }).isTrigger).toBe(false);
  });

  test("category tone ignores capitalisation", () => {
    // `category` is authored free text with an open set. `Triggers` against
    // `triggers` has already shipped once; a tone that only matched one
    // spelling would have drawn that node in the wrong colour with nothing
    // reporting it.
    for (const en of ["triggers", "Triggers", " TRIGGERS "]) {
      expect(
        resolveWorkflowNodePresentation({
          nodeType: "triggerManual",
          entry: { type: "triggerManual", category: { en } },
        }).categoryTone,
      ).toBe("trigger");
    }
    expect(
      resolveWorkflowNodePresentation({
        nodeType: "decision",
        entry: { type: "decision", category: { en: "Flow", nl: "Stroom" } },
      }).categoryTone,
    ).toBe("default");
  });

  test("the tone does not change with the reader's language", () => {
    // `category` is a locale map since #260, so it carries a translation the
    // tone must not read: a card that turned a different colour in Dutch would
    // be the same drift the fold was introduced to stop, one locale further on.
    const entry = { type: "triggerManual", category: { en: "Triggers", nl: "Aanjagers" } };
    for (const locale of ["en", "nl", "fr"]) {
      expect(
        resolveWorkflowNodePresentation({ nodeType: "triggerManual", entry, locale })
          .categoryTone,
      ).toBe("trigger");
    }
  });

  test("the label follows the requested locale, then English, then anything", () => {
    const entry = {
      type: "decision",
      label: { en: "Decision", nl: "Keuze" },
    };
    expect(
      resolveWorkflowNodePresentation({ nodeType: "decision", entry, locale: "nl" }).typeLabel,
    ).toBe("Keuze");
    expect(
      resolveWorkflowNodePresentation({ nodeType: "decision", entry, locale: "de" }).typeLabel,
    ).toBe("Decision");
    // No English either: any populated entry beats showing the raw type.
    expect(
      resolveWorkflowNodePresentation({
        nodeType: "decision",
        entry: { type: "decision", label: { fr: "Décision" } },
        locale: "de",
      }).typeLabel,
    ).toBe("Décision");
    // An empty string is not a label; the type is more useful than a blank card.
    expect(
      resolveWorkflowNodePresentation({
        nodeType: "decision",
        entry: { type: "decision", label: { en: "   " } },
      }).typeLabel,
    ).toBe("decision");
  });
});
