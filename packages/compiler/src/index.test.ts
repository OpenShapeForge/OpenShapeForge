// SPDX-License-Identifier: BUSL-1.1
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { collectAllArtifacts } from "./index.js";
import { renderEmptyApiPersistedOperationArtifact } from "./persisted-operations.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function hostRoot(options: { web?: boolean; plugin?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "osf-compiler-host-"));
  roots.push(root);
  await mkdir(join(root, "documents-plugin"), { recursive: true });
  await writeFile(
    join(root, "documents-plugin", "index.ts"),
    'export default { name: "documents" };\n',
  );
  await writeFile(
    join(root, "documents-plugin", "runtime.ts"),
    'export default { name: "documents", operationHandlers: {} };\n',
  );
  await mkdir(join(root, "versioning-plugin"), { recursive: true });
  await writeFile(
    join(root, "versioning-plugin", "index.ts"),
    'export default { name: "core-versioning" };\n',
  );
  await writeFile(
    join(root, "versioning-plugin", "runtime.ts"),
    'export default { name: "core-versioning", operationHandlers: {} };\n',
  );
  await writeFile(
    join(root, "authoring.config.yaml"),
    [
      "layers:",
      "  - packages/compiler/config/authoring",
      "plugins:",
      "  - ./versioning-plugin/index.ts",
      "  - ./documents-plugin/index.ts",
      ...(options.plugin ? [`  - ./${options.plugin}`] : []),
      "",
    ].join("\n"),
  );
  if (options.web) {
    await mkdir(join(root, "apps/web"), { recursive: true });
  }
  return root;
}

describe("compiler host artifact assembly", () => {
  test("headless hosts receive exactly one deterministic empty API manifest", async () => {
    const root = await hostRoot();
    const first = await collectAllArtifacts(root);
    const second = await collectAllArtifacts(root);
    const path = "apps/api/src/generated/graphql/persisted-operations.json";
    const matches = first.all.filter((artifact) => artifact.path === path);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual(renderEmptyApiPersistedOperationArtifact());
    expect(first.groups.ui).toEqual([]);
    expect(second.all).toEqual(first.all);
  }, 60_000);

  test("headless hosts receive the merged raw field-authoring registries", async () => {
    const root = await hostRoot();
    const overlay = join(root, "authoring-overlay", "catalogs");
    await mkdir(overlay, { recursive: true });
    await writeFile(
      join(overlay, "field-authoring-profiles.yaml"),
      [
        "profiles:",
        "  hostProfile:",
        "    label: { nl: Hostprofiel, en: Host profile }",
        "    futureProfileProperty: keep-me",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(overlay, "osf-types.yaml"),
      [
        "types:",
        "  hostType:",
        "    label: { nl: Hosttype, en: Host type }",
        "    valueType: string",
        "    futureSemanticProperty: keep-me",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(overlay, "core-referentiedata.yaml"),
      [
        "groepen:",
        "  HOST_GROUP:",
        "    description: Keep raw group metadata",
        "    futureGroupProperty: keep-me",
        "    items:",
        "      - value: host-value",
        "        label: { nl: Hostwaarde, en: Host value }",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "authoring.config.yaml"),
      [
        "layers:",
        "  - packages/compiler/config/authoring",
        "  - authoring-overlay",
        "plugins:",
        "  - ./versioning-plugin/index.ts",
        "  - ./documents-plugin/index.ts",
        "",
      ].join("\n"),
    );

    const { groups } = await collectAllArtifacts(root);
    const artifact = groups.operations.find(
      (entry) =>
        entry.path === "apps/api/src/generated/compiler/field-authoring-registry.json",
    );
    expect(artifact).toBeDefined();
    expect(JSON.parse(artifact!.contents)).toMatchObject({
      version: 1,
      fieldAuthoringProfiles: {
        workflowInputField: { typePickerUsage: "requestInput" },
        hostProfile: { futureProfileProperty: "keep-me" },
      },
      osfTypes: {
        email: { valueType: "string" },
        hostType: { futureSemanticProperty: "keep-me" },
      },
      referentiedata: {
        RELATIONTYPE: { description: expect.any(String) },
        HOST_GROUP: {
          description: "Keep raw group metadata",
          futureGroupProperty: "keep-me",
        },
      },
    });
  }, 60_000);

  test("web hosts retain persisted operations and receive a web interface manifest", async () => {
    const root = await hostRoot({ web: true });
    const { all } = await collectAllArtifacts(root);
    const paths = [
      "apps/api/src/generated/graphql/persisted-operations.json",
      "apps/web/src/generated/persisted-operations.json",
    ];
    const persisted = all.filter((artifact) => paths.includes(artifact.path));

    expect(persisted.map((artifact) => artifact.path).sort()).toEqual(paths);
    expect(persisted[0]!.contents).toBe(persisted[1]!.contents);
    expect(JSON.parse(persisted[0]!.contents).operationNames.length).toBeGreaterThan(0);
    const webManifestArtifact = all.find(
      (artifact) => artifact.path === "apps/web/src/generated/web-manifest.json",
    );
    expect(webManifestArtifact).toBeDefined();
    expect(JSON.parse(webManifestArtifact!.contents)).toMatchObject({
      contract: "openshapeforge.web-manifest",
      version: 1,
      entities: { Relation: { operations: { list: { id: "Relation.list" } } } },
    });
  }, 60_000);

  test("committed REST onboarding reaches the generated OpenAPI artifact", async () => {
    const root = await hostRoot();
    await writeFile(
      join(root, "authoring.config.yaml"),
      [
        "layers:",
        "  - packages/compiler/config/authoring",
        "plugins:",
        "  - ./versioning-plugin/index.ts",
        "  - ./documents-plugin/index.ts",
        "restApi:",
        "  title: Example Product API",
        "  description: Authenticate first, then follow the integration workflow.",
        "  bearerDescription: Paste an access token issued for this API.",
        "  oauth2:",
        "    description: Sign in through the host identity provider.",
        "    authorizationUrl: https://identity.example.com/oauth/authorize",
        "    tokenUrl: https://identity.example.com/oauth/token",
        "    clientId: public-docs-client",
        "    scopes:",
        "      openid: Sign in",
        "  externalDocs:",
        "    description: Developer guide",
        "    url: https://example.com/developers",
        "",
      ].join("\n"),
    );

    const { groups } = await collectAllArtifacts(root);
    const openApi = JSON.parse(
      groups.db.find(
        (artifact) => artifact.path === "apps/api/src/generated/rest/openapi.json",
      )!.contents,
    ) as {
      info: { title: string; version: string; description: string };
      externalDocs: { description: string; url: string };
      security: Array<Record<string, string[]>>;
      components: { securitySchemes: Record<string, Record<string, unknown>> };
    };

    expect(openApi.info.title).toBe("Example Product API");
    expect(openApi.info.version).toBe("1");
    expect(openApi.info.description).toStartWith(
      "Authenticate first, then follow the integration workflow.",
    );
    expect(openApi.info.description).toContain("## Start here");
    expect(openApi.info.description).toContain("Generated by @openshapeforge/compiler");
    expect(openApi.externalDocs).toEqual({
      description: "Developer guide",
      url: "https://example.com/developers",
    });
    expect(openApi.security).toEqual([{ bearerAuth: [] }, { oauth2Auth: [] }]);
    expect(openApi.components.securitySchemes.bearerAuth!.description).toBe(
      "Paste an access token issued for this API.",
    );
    expect(openApi.components.securitySchemes.oauth2Auth).toMatchObject({
      type: "oauth2",
      "x-swagger-ui-client-id": "public-docs-client",
    });
  }, 60_000);

  test("independent producers still fail closed on duplicate paths", async () => {
    const plugin = "duplicate-plugin.ts";
    const root = await hostRoot({ plugin });
    await writeFile(
      join(root, plugin),
      `export default {
        name: "duplicate-artifact",
        generate() {
          return [{
            path: "apps/api/src/generated/graphql/persisted-operations.json",
            contents: "{}\\n",
          }];
        },
      };\n`,
    );

    await expect(collectAllArtifacts(root)).rejects.toThrow(
      "Artifact path collision: apps/api/src/generated/graphql/persisted-operations.json emitted twice.",
    );
  }, 60_000);
});
