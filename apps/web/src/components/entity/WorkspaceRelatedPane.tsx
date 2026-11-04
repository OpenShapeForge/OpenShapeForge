// SPDX-License-Identifier: BUSL-1.1
"use client";

import { BodyHeader } from "@/components/ui/layout/body-header";
import {
  detailPaneToRendererDefinition,
  translateDetailText,
} from "@/components/entity/entity-detail-contract";
import type { DetailFieldConfig, DetailGroup } from "@/components/entity/entity-detail-contract";
import { Renderer } from "@/features/renderer/components/renderer";
import type { RendererFormDefinition } from "@/features/renderer/form-definition";

type RelatedPaneConfig = {
  title?: { en: string; nl: string };
  groups: DetailGroup[];
  fields?: DetailFieldConfig[];
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  weight?: number;
  resizable?: boolean;
};

type WorkspaceRelatedPaneProps = {
  entity: Record<string, unknown>;
  lang: string;
  config: RelatedPaneConfig;
};

export function WorkspaceRelatedPane({
  entity,
  lang,
  config,
}: WorkspaceRelatedPaneProps) {
  const definition: RendererFormDefinition = detailPaneToRendererDefinition(
    config,
    {
      groupInterpretation: ["none"],
      chrome: {
        showTitle: false,
        showDescription: false,
        showGroupTitles: true,
        showGroupDescriptions: false,
        showActionBar: false,
      },
    },
  );

  return (
    <div className="space-y-4">
      {config.title ? (
        <BodyHeader
          title={translateDetailText(config.title, lang)}
          showBackButton={false}
          className="space-y-0"
        />
      ) : null}
      <Renderer
        definition={definition}
        lang={lang}
        showTitle={false}
        showDescription={false}
        initialData={entity}

      />
    </div>
  );
}
