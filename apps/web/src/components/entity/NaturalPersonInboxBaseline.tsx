// SPDX-License-Identifier: BUSL-1.1
"use client";

import {
  BaseLayout,
  DatascreenRelations,
  Inbox,
  InboxCategoryShowMore,
  InboxList,
  InboxMessage,
  InboxSection,
  RowPanelheader,
  RowSectionheader,
  Surface,
} from "@openshapeforge/ui";

type NaturalPersonInboxBaselineProps = {
  headerEntity?: {
    title: string;
    role?: string;
    chips?: string[];
    initials?: string;
  } | null;
  lang: string;
};

const copy = (
  lang: string,
  text: {
    nl: string;
    en: string;
  },
) => (lang === "nl" ? text.nl : text.en);

function RelationsColumn({
  headerEntity,
  lang,
}: {
  headerEntity?: NaturalPersonInboxBaselineProps["headerEntity"];
  lang: string;
}) {
  const resolvedHeader = headerEntity ?? {
    title: copy(lang, { nl: "Geen persoon geselecteerd", en: "No person selected" }),
    role: copy(lang, { nl: "Selecteer een persoon", en: "Select a person" }),
    chips: [copy(lang, { nl: "Mockdata", en: "Mock data" })],
  };

  return (
    <DatascreenRelations
      className="h-full min-h-0"
      title="Relaties"
      unit={{
        kind: "person",
        title: resolvedHeader.title,
        role: resolvedHeader.role,
        chips: resolvedHeader.chips,
        initials: resolvedHeader.initials,
        showRole: true,
        showTags: true,
      }}
      groups={[
        {
          label: "CONTRACT",
          records: [{ kind: "contract", title: "Hoofdhuurovereenkomst" }],
        },
        {
          label: "ORGANISATIE",
          records: [{ kind: "organisation", title: "ACME Wonen" }],
        },
        {
          label: "HUISHOUDEN",
          records: [
            {
              kind: "household",
              title: "S. Jansen & M. Jansen",
              initials: "SJ",
              showSubtitle: false,
            },
          ],
        },
        {
          label: "PERSONEN",
          records: [
            { kind: "person", title: "Sophie Jansen", showSubtitle: false },
            { kind: "person", title: "Milan Jansen", showSubtitle: false },
          ],
        },
      ]}
    />
  );
}

function InboxColumn({ lang }: { lang: string }) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-card)]">
      <RowPanelheader
        title={copy(lang, { nl: "Inbox", en: "Inbox" })}
        showChevron={false}
        showClose={false}
        className="shrink-0"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Inbox>
          <InboxSection label={copy(lang, { nl: "NIEUW", en: "NEW" })}>
            <InboxList>
              <InboxMessage
                iconType="whatsapp"
                title="Sophie Jansen"
                subtitle={copy(lang, {
                  nl: "Vraag over reparatieverzoek",
                  en: "Question about repair request",
                })}
                className="bg-[var(--color-accent)]"
              />
              <InboxMessage
                iconType="mail"
                title="Milan Jansen"
                subtitle={copy(lang, {
                  nl: "Documenten voor inschrijving",
                  en: "Documents for registration",
                })}
              />
            </InboxList>
          </InboxSection>
          <InboxSection
            label={copy(lang, {
              nl: "IN BEHANDELING",
              en: "IN PROGRESS",
            })}
          >
            <InboxList>
              <InboxMessage
                iconType="agent"
                title="Woonconsulent"
                subtitle={copy(lang, {
                  nl: "Controle huurachterstand",
                  en: "Rent arrears check",
                })}
              />
              <InboxCategoryShowMore
                label={copy(lang, { nl: "Toon meer", en: "Show more" })}
              />
            </InboxList>
          </InboxSection>
          <InboxSection label={copy(lang, { nl: "AFGEROND", en: "COMPLETED" })}>
            <InboxList>
              <InboxMessage
                iconType="messaging"
                title="Dossier bijgewerkt"
                subtitle={copy(lang, {
                  nl: "Contactgegevens bevestigd",
                  en: "Contact details confirmed",
                })}
              />
            </InboxList>
          </InboxSection>
        </Inbox>
      </div>
    </div>
  );
}

function ContextColumn({ lang }: { lang: string }) {
  return (
    <Surface
      variant="card"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-none border-0"
    >
      <RowPanelheader
        title={copy(lang, { nl: "Context", en: "Context" })}
        showChevron={false}
        showClose={false}
        className="shrink-0"
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-8">
        <RowSectionheader label={copy(lang, { nl: "PROFIEL", en: "PROFILE" })} />
        <div className="space-y-3 px-4 py-3 text-[13px] leading-[20px] tracking-[-0.39px] text-[var(--color-foreground-subtle)]">
          <p className="font-medium text-[var(--color-foreground)]">Sophie Jansen</p>
          <p>Huurder sinds 2019. Voorkeurstaal Nederlands. Bereikbaar via WhatsApp en e-mail.</p>
        </div>
        <RowSectionheader label={copy(lang, { nl: "SAMENVATTING", en: "SUMMARY" })} />
        <div className="space-y-3 px-4 py-3 text-[13px] leading-[20px] tracking-[-0.39px] text-[var(--color-foreground-subtle)]">
          <p>Open reparatieverzoek voor lekkage in de badkamer. Laatste contactmoment was vandaag om 09:42.</p>
          <p>Geen API-koppeling actief: deze kolom gebruikt mockdata als baseline.</p>
        </div>
      </div>
    </Surface>
  );
}

export function NaturalPersonInboxBaseline({
  headerEntity,
  lang,
}: NaturalPersonInboxBaselineProps) {
  return (
    <BaseLayout
      variant="inbox-main-context"
      sidebar={false}
      tabs={false}
      resizable
      left={<RelationsColumn headerEntity={headerEntity} lang={lang} />}
      main={<InboxColumn lang={lang} />}
      right={<ContextColumn lang={lang} />}
      leftSize={{ defaultWidth: 400, minWidth: 400, maxWidth: 400 }}
      mainSize={{ minWidth: 180, weight: 1 }}
      rightSize={{ defaultWidth: 220, minWidth: 180, maxWidth: 560 }}
      mainClassName="p-0"
      leftClassName="bg-[var(--color-card)]"
      rightClassName="bg-[var(--color-card)]"
      cardClassName="rounded-[var(--radius-large)]"
      className="h-full min-h-[720px] border-0 outline-0"
      storageKey="natural-person-inbox-baseline"
      persistKey="mock"
    />
  );
}
