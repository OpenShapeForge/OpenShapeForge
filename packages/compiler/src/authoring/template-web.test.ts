// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadEntity } from "./loader.js";
import { compile } from "./compiler/index.js";
import { buildWebManifest } from "./web-manifest.js";

const directory = join(import.meta.dir, "../../config/authoring");
const slugs = ["template", "template-version", "template-variant", "block", "text-block", "youtube-embed", "template-block"];

test("template editors can read the records they are allowed to create", () => {
  for (const slug of slugs) {
    const entity = loadEntity(directory, slug);
    for (const role of entity.authorization?.roles?.create ?? []) {
      expect(entity.authorization?.roles?.read).toContain(role);
    }
  }
});

test("real template Web contracts expose owned collections as navigable editor tabs", () => {
  const entities = slugs.map(slug => ({ slug, contract: compile(loadEntity(directory, slug)) }));
  const manifest = buildWebManifest(entities, { requireTranslations: true });
  for (const [name, relationship] of [["Template", "versions"], ["TemplateVersion", "variants"], ["TemplateVariant", "blocks"]]) {
    const entity = manifest.entities[name!]!;
    expect(entity.relationships[relationship!]!.operations.insert).toBeDefined();
    expect(JSON.stringify(entity.views.record)).toContain(`"relationshipId":"${relationship}"`);
  }
});
