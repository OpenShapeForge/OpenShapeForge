// SPDX-License-Identifier: BUSL-1.1
/** The migration as one pure function over a loaded corpus; see cli.ts. */
import type { YAMLMap } from "yaml";
import { type Corpus, type CorpusFile, fileChanged, getSeq, yaml } from "./corpus.ts";
import { type FoldReport, declareAmbiguousInverses, foldAuthoredCollections, pruneEmptyRelationship } from "./inverse-fold.ts";
import { type LegacyFoldOptions, type LegacyFoldReport, foldLegacyBelongsTo, foldLegacyHasMany } from "./legacy-relationships.ts";
import { type RenameReport, isDefinitionDocument, renameTypeAxis, renameTypeCatalog } from "./rename.ts";

export type MigrationOptions = LegacyFoldOptions & {
  /** Rename inside seed/fixture files that are not compiler definitions. */
  includeSeeds?: boolean;
};

export interface MigrationReport {
  legacy: LegacyFoldReport;
  fold: FoldReport;
  rename: RenameReport;
}

export interface MigrationResult {
  report: MigrationReport;
  /** Files whose parsed content changed. */
  changed: CorpusFile[];
}

export function migrateCorpus(corpus: Corpus, options: MigrationOptions = {}): MigrationResult {
  const report: MigrationReport = {
    legacy: { belongsToFolded: [], fieldsCreated: [], hasManyRemoved: [], errors: [] },
    fold: { collectionsFolded: [], ambiguityDeclared: [], errors: [] },
    rename: { renamed: 0, derivedFromValueType: 0, valueTypesDropped: 0, skipped: [], catalogs: [] },
  };
  // Every belongsTo across the corpus first: a hasMany's inverse may be a
  // field another entity's belongsTo fold only just created.
  for (const file of corpus.files) foldLegacyBelongsTo(corpus, file, options, report.legacy);
  for (const file of corpus.files) foldLegacyHasMany(corpus, file, report.legacy);
  for (const file of corpus.files) foldAuthoredCollections(corpus, file, report.fold);
  for (const file of corpus.files) declareAmbiguousInverses(corpus, file, report.fold);
  for (const file of corpus.files) {
    if (!isDefinitionDocument(file, options.includeSeeds)) {
      if (/\b(valueType|semanticType)\b/.test(file.source)) report.rename.skipped.push(file.path);
      continue;
    }
    renameTypeCatalog(file, report.rename);
    renameTypeAxis(file.doc.contents, report.rename);
    if (file.kind === "coreEntity" && yaml.isMap(file.doc.contents)) {
      for (const item of getSeq(file.doc.contents as YAMLMap, "fields")?.items ?? []) {
        if (yaml.isMap(item)) pruneEmptyRelationship(item as YAMLMap);
      }
    }
  }
  const changed = corpus.files.filter(fileChanged);
  return { report, changed };
}
