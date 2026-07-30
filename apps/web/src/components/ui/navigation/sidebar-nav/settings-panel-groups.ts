// SPDX-License-Identifier: BUSL-1.1
import type { SettingsPanelGroup } from "@/lib/navigation/types";

export const DEFAULT_SETTINGS_PANEL_GROUPS: SettingsPanelGroup[] = [
  {
    label: "Werk & dossiers",
    items: [
      { label: "Home", href: "/" },
      { label: "Zaken", href: "/cases" },
      { label: "Dossiers", href: "/dossiers" },
      { label: "Processen", href: "/processes" },
      { label: "Documenten", href: "/documents" },
      { label: "Werkqueues", href: "/work-queues" },
      { label: "SLA-beleid", href: "/sla-policies" },
      { label: "Zaaktypen", href: "/case-types" },
    ],
  },
  {
    label: "Support",
    items: [{ label: "Support", href: "/support-issues" }],
  },
  {
    label: "Relaties",
    items: [
      { label: "Personen", href: "/natural-persons" },
      { label: "Organisaties", href: "/legal-entities" },
      { label: "Relatiegroepen", href: "/relation-groups" },
    ],
  },
  {
    label: "Kwaliteit",
    items: [
      { label: "Kwaliteitsmetingen", href: "/quality-measurements" },
      { label: "Vragenlijsten", href: "/surveys" },
      { label: "Onderzoeksopdrachten", href: "/research-assignments" },
      { label: "Conditiemetingen", href: "/condition-assessments" },
    ],
  },
  {
    label: "Contractmanagement",
    items: [
      { label: "Overeenkomsten", href: "/agreements" },
      { label: "Overeenkomstcomponenten", href: "/agreement-components" },
      { label: "Overeenkomstcomponenttypen", href: "/agreement-component-types" },
      { label: "Overeenkomstpartijen", href: "/agreement-parties" },
      { label: "Overeenkomstkoppelingen", href: "/agreement-links" },
    ],
  },
  {
    label: "Bezit",
    items: [
      { label: "Gebouwen", href: "/buildings" },
      { label: "Panden", href: "/premises" },
      { label: "Ruimten", href: "/spaces" },
      { label: "Clusters", href: "/clusters" },
      { label: "Collectieve objecten", href: "/collective-objects" },
      { label: "Bouwdelen", href: "/building-parts" },
      { label: "Bouwkundige elementen", href: "/building-elements" },
      { label: "Adresseerbare objecten", href: "/addressable-objects" },
      { label: "Geometrieen", href: "/geometries" },
      { label: "BAG-adressen", href: "/bag-addresses" },
      { label: "BAG-panden", href: "/bag-premises" },
      { label: "BAG-woonplaatsen", href: "/bag-localities" },
      { label: "Buurten", href: "/neighborhoods" },
      { label: "Wijken", href: "/districts" },
      { label: "Woonplaatsen", href: "/localities" },
      { label: "Gemeenten", href: "/municipalities" },
      { label: "Percelen", href: "/parcels" },
      { label: "Oppervlakten", href: "/surface-areas" },
      { label: "Eenheidadressen", href: "/unit-addresses" },
      { label: "Eenheidcriteria", href: "/unit-criteria" },
      { label: "Eenheidtoestanden", href: "/unit-states" },
      { label: "Eenheidvoorwaarden", href: "/unit-conditions" },
      { label: "Vertrekken", href: "/rooms" },
      { label: "Renovaties", href: "/renovations" },
      { label: "Marktwaarden", href: "/market-values" },
      { label: "Beleidswaarden", href: "/policy-values" },
      { label: "Taxaties", href: "/valuations" },
      { label: "Garanties", href: "/guarantees" },
      { label: "WOZ-eenheden", href: "/woz-units" },
      { label: "Zekerheid verpandingen", href: "/security-interests" },
      { label: "Stadsdelen", href: "/boroughs" },
      { label: "Woningwaarderingcriteria", href: "/housing-valuation-criteria" },
      { label: "Woningwaardering criteriumgroepen", href: "/housing-valuation-criterion-groups" },
      { label: "Woningwaarderingen", href: "/housing-valuations" },
      { label: "Woningwaarderinggroepen", href: "/housing-valuation-groups" },
      { label: "Woningwaarderingresultaten", href: "/housing-valuation-results" },
    ],
  },
  {
    label: "Onderhoud",
    items: [
      { label: "Defecten", href: "/defects" },
      { label: "Inspectierapporten", href: "/inspection-reports" },
      { label: "Onderhoudsorders", href: "/maintenance-orders" },
      { label: "Onderhoudstaken", href: "/maintenance-tasks" },
      { label: "Onderhoudsbestedingen", href: "/maintenance-expenditures" },
      { label: "Onderhoudstaakvoorcalculaties", href: "/maintenance-task-estimates" },
      { label: "Onderhoudsverzoekverrekeningen", href: "/maintenance-request-settlements" },
      { label: "Standaardprijzen", href: "/standard-prices" },
      { label: "Onderhoudsleveranciers", href: "/maintenance-suppliers" },
      { label: "Garanties", href: "/warranties" },
      { label: "Leveranciers", href: "/supplier-roles" },
    ],
  },
  {
    label: "Objecten & energie",
    items: [
      { label: "Objecten", href: "/assets" },
      { label: "Objectgroepen", href: "/asset-groups" },
      { label: "Waarderingen", href: "/valuations" },
      { label: "Zekerheden", href: "/encumbrances" },
      { label: "Bestuurlijke gebieden", href: "/admin-regions" },
      { label: "Energieprestaties", href: "/energy-performances" },
      { label: "Monitorlogs", href: "/monitor-logs" },
      { label: "Monitorintervallen", href: "/monitor-intervals" },
    ],
  },
  {
    label: "Financieel",
    items: [
      { label: "Boekjaren", href: "/fiscal-years" },
      { label: "Boekjaarperioden", href: "/fiscal-periods" },
      { label: "BTW-tarieven", href: "/vat-rates" },
      { label: "Kostendimensies", href: "/cost-dimensions" },
      { label: "Betaalwijzen", href: "/payment-methods" },
      { label: "Prolongatieruns", href: "/billing/prolongation-runs" },
      { label: "Facturen", href: "/invoices" },
      { label: "Factuurbetalingen", href: "/invoice-payments" },
      { label: "Factuurreeksen", href: "/invoice-sequences" },
      { label: "Offertes", href: "/quotes" },
      { label: "Machtigingen", href: "/direct-debit-mandates" },
      { label: "Incasso-opdrachten", href: "/direct-debit-orders" },
      { label: "Betaalopdrachten", href: "/payment-orders" },
      { label: "Bankafschriften", href: "/bank-statements" },
      { label: "Boekingen", href: "/ledger-postings" },
      { label: "BTW-aangiftes", href: "/vat-returns" },
      { label: "Inkooporders", href: "/purchase-orders" },
      { label: "Begrotingen", href: "/budgets" },
      { label: "Prijsaanpassingen", href: "/price-adjustments" },
      { label: "Betalingsregelingen", href: "/payment-plans" },
      { label: "Crediteuren", href: "/creditors" },
      { label: "Debiteuren", href: "/debtors" },
    ],
  },
  {
    label: "Organisatie",
    items: [
      { label: "Medewerkers", href: "/employees" },
      { label: "Organisatorische eenheden", href: "/org-units" },
      { label: "Functies", href: "/positions" },
      { label: "Vacatures", href: "/vacancies" },
      { label: "Tijdsbestedingen", href: "/time-entries" },
    ],
  },
  {
    label: "Projecten",
    items: [
      { label: "Projecttaken", href: "/project-tasks" },
      { label: "Projectopdrachten", href: "/project-orders" },
    ],
  },
  {
    label: "Workflow",
    items: [{ label: "Workflow Viewer", href: "/workflow-instances" }],
  },
  {
    label: "Messaging",
    items: [
      { label: "WhatsApp-instellingen", href: "/messaging/whatsapp" },
      { label: "Mailaccounts", href: "/messaging/mail" },
      { label: "Templates", href: "/templates" },
      { label: "Templatevarianten", href: "/template-variants" },
    ],
  },
  {
    label: "Instellingen",
    items: [
      { label: "Tenants", href: "/tenants" },
      { label: "Tenantinstellingen", href: "/tenant-settings" },
      { label: "Beleidsregels", href: "/policies" },
      { label: "Globale variabelen", href: "/chips" },
      { label: "Communicatievoorkeuren", href: "/communication-preferences" },
      { label: "Voorkeuren", href: "/preferences" },
      { label: "Labelregels", href: "/label-rules" },
    ],
  },
];

export function mergeSettingsPanelGroups(
  baseGroups: SettingsPanelGroup[],
  additionalGroups: SettingsPanelGroup[] | undefined,
): SettingsPanelGroup[] {
  if (!additionalGroups?.length) return baseGroups;

  const merged = baseGroups.map((group) => ({
    ...group,
    items: [...group.items],
  }));

  for (const addition of additionalGroups) {
    const existing = merged.find((group) => group.label === addition.label);
    if (!existing) {
      merged.push({ ...addition, items: [...addition.items] });
      continue;
    }

    const existingHrefs = new Set(existing.items.map((item) => item.href));
    for (const item of addition.items) {
      if (existingHrefs.has(item.href)) continue;
      existing.items.push(item);
      existingHrefs.add(item.href);
    }
  }

  return merged;
}
