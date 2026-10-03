// SPDX-License-Identifier: BUSL-1.1
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { collectAllArtifacts, runCompiler } from "./index.js";
import { renderEmptyApiPersistedOperationArtifact } from "./persisted-operations.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function hostRoot(options: { web?: boolean; plugin?: string; minimalAuthoring?: boolean } = {}) {
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
  if (options.minimalAuthoring) {
    await mkdir(join(root, "packages/compiler/config"), { recursive: true });
    await writeFile(join(root, "packages/compiler/config/platform-schema.yaml"), "version: 1\ntables: []\n");
    await mkdir(join(root, "path-fixture/entities"), { recursive: true });
    await cp(join(import.meta.dir, "../config/authoring/entities/_base.yaml"), join(root, "path-fixture/entities/_base.yaml"));
    const identityFields: Record<string, string[]> = {
      relation: ["displayName", "relationType", "status", "businessContext"],
      "natural-person": ["relationId", "firstName", "lastName"],
      "contact-detail": ["relationId", "type", "value", "isPrimary", "status"],
    };
    for (const [slug, fields] of Object.entries(identityFields)) {
      const source = parse(await readFile(join(import.meta.dir, `../config/authoring/entities/core/${slug}.yaml`), "utf8"));
      const entity = Object.fromEntries(["schemaVersion", "kind", "module", "entity", "title", "description", "language", "authorization", "operations", "interfaces"]
        .map(key => [key, source[key]]));
      entity.interfaces = { ...source.interfaces, web: { operations: source.interfaces.web.operations } };
      entity.fields = source.fields.filter((field: { key: string }) => fields.includes(field.key));
      await writeFile(join(root, `path-fixture/entities/${slug}.yaml`), stringify(entity));
    }
    await cp(join(import.meta.dir, "../config/authoring/authorization.yaml"), join(root, "path-fixture/authorization.yaml"));
    await cp(join(import.meta.dir, "../config/authoring/catalogs"), join(root, "path-fixture/catalogs"), { recursive: true });
  }
  await writeFile(
    join(root, "authoring.config.yaml"),
    [
      "layers:",
      options.minimalAuthoring ? "  - path-fixture" : "  - packages/compiler/config/authoring",
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
  test("rejects traversal and aliased artifact paths before writing any output", async () => {
    const plugin = "path-plugin.ts";
    // Artifact assembly security does not depend on the full entity corpus.
    // Keep all path cases on the real compiler with a minimal host instead.
    const root = await hostRoot({ plugin, minimalAuthoring: true });
    await writeFile(join(root, plugin), `
      export const artifact = { path: "placeholder", contents: "replacement" };
      export default { name: "path-fixture", generate: () => [artifact] };
    `);
    const { artifact } = await import(join(root, plugin));
    const protectedPath = join(root, "apps/api/src/generated/graphql/persisted-operations.json");
    await mkdir(join(protectedPath, ".."), { recursive: true });
    await writeFile(protectedPath, "original");
    for (const path of [
      "apps/api/src/generated/graphql/../graphql/persisted-operations.json",
      "../outside.txt", "/outside.txt", "C:/outside.txt", "C:\\outside.txt",
      "./apps/api/src/generated/graphql/persisted-operations.json",
      "apps//duplicate.txt", "", "apps/invalid\0.txt",
    ]) {
      artifact.path = path;
      await expect(runCompiler({ repoRoot: root })).rejects.toThrow("canonical repo-relative path");
      expect(await readFile(protectedPath, "utf8")).toBe("original");
      await expect(readFile(join(root, "apps/api/src/generated/db/schema.sql"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
    artifact.path = "apps/api/src/generated/graphql/persisted-operations.json";
    await expect(runCompiler({ repoRoot: root })).rejects.toThrow("Artifact path collision");
    expect(await readFile(protectedPath, "utf8")).toBe("original");
    artifact.path = "plugin/generated.json";
    await runCompiler({ repoRoot: root });
    expect(await readFile(join(root, artifact.path), "utf8")).toBe("replacement");
  }, 60_000);

  test("CLI refuses a missing repo-root value before compilation", async () => {
    const root = await hostRoot();
    for (const args of [["--repo-root"], ["--repo-root", "--unexpected"]]) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toContain("--repo-root requires a directory path");
    }
  }, 30_000);

  test("rejects an Operation name claimed by a different compatibility bridge", async () => {
    const plugin = "collision-plugin/index.ts";
    const root = await hostRoot({ plugin });
    await mkdir(join(root, "collision-plugin"), { recursive: true });
    await writeFile(
      join(root, plugin),
      `const operation = (key, handler, path, mcp) => ({
        key,
        title: key,
        description: key,
        handler,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: { type: "object", properties: {}, additionalProperties: false },
        errors: [],
        auth: { mode: "session", roles: ["Relations.All.Read"] },
        tenancy: { mode: "required" },
        idempotency: { mode: "none" },
        effects: { data: "read", external: "none" },
        transports: {
          rest: { method: "POST", path, response: { kind: "json" } },
          mcp,
          graphql: { enabled: false, reason: "Not needed for this regression fixture." },
          typescript: { enabled: false, reason: "Not needed for this regression fixture." },
        },
      });
      export default {
        name: "collision",
        operations: [
          operation(
            "collision.inspect",
            "inspect",
            "/api/collision/inspect",
            { enabled: false, reason: "Projected through the compatibility discovery tool." },
          ),
          operation(
            "collision.conflict",
            "conflict",
            "/api/collision/conflict",
            { enabled: true, name: "osf_internal_collision_collision_inspect" },
          ),
        ],
        executionCompatibility: {
          version: 1,
          discovery: [{ operation: "collision.inspect", entity: "Relation" }],
        },
      };
      `,
    );
    await writeFile(
      join(root, "collision-plugin", "runtime.ts"),
      `export default {
        name: "collision",
        operationHandlers: {
          inspect: async () => ({}),
          conflict: async () => ({}),
        },
      };
      `,
    );

    await expect(collectAllArtifacts(root)).rejects.toThrow(
      'Duplicate MCP tool name "osf_internal_collision_collision_inspect": claimed by both compatibility tool for Operation "collision.inspect" and canonical Operation "collision.conflict".',
    );
  }, 60_000);

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
        "    baseType: string",
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
        caseVariable: { typePickerUsage: "requestInput" },
        hostProfile: { futureProfileProperty: "keep-me" },
      },
      osfTypes: {
        email: { baseType: "string" },
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
