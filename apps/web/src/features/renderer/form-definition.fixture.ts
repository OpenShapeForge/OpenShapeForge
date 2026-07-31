// SPDX-License-Identifier: BUSL-1.1
import type { RendererFormDefinition } from "@/features/renderer/form-definition";

export const LEGAL_ENTITY_FORM_DEFINITION: RendererFormDefinition = {
  schemaVersion: 1,
  id: "legal-entity.edit",
  kind: "form",
  mode: "edit",
  title: {
    en: "Edit legal entity",
    nl: "Rechtspersoon bewerken",
  },
  description: {
    en: "Canonical renderer example based on the compiler legal-entity definition.",
    nl: "Canoniek renderer-voorbeeld op basis van de compilerdefinitie van een rechtspersoon.",
  },
  metadata: {
    compiler: {
      sourceEntity: "legal-entity",
      sourceVariant: "edit",
      sourceView: "legal-entity.view.yaml",
    },
  },
  presentation: {
    surface: "page",
    density: "default",
    layout: {
      columns: 2,
    },
    groupInterpretation: ["tab", "card", "group"],
    chrome: {
      showTitle: true,
      showDescription: true,
      showGroupTitles: true,
      showGroupDescriptions: true,
      showActionBar: true,
    },
  },
  submission: {
    successRoute: "/rechtspersonen/:id",
    successBehavior: "redirect",
  },
  groups: [
    {
      id: "general",
      title: {
        en: "General",
        nl: "Algemeen",
      },
      description: {
        en: "Core identity and naming fields for the legal entity.",
        nl: "Kerngegevens en naamvelden van de rechtspersoon.",
      },
      groups: [
        {
          id: "identity",
          title: {
            en: "Identity",
            nl: "Identiteit",
          },
          description: {
            en: "Primary details shown in generated entity screens.",
            nl: "Primaire gegevens zoals ze ook in gegenereerde entity-schermen verschijnen.",
          },
          fields: ["name", "legalForm"],
        },
      ],
    },
    {
      id: "registration",
      title: {
        en: "Registration",
        nl: "Registratie",
      },
      description: {
        en: "Registry, tax, and chain-identification details.",
        nl: "Register-, fiscale en ketenidentificatiegegevens.",
      },
      groups: [
        {
          id: "registry",
          title: {
            en: "Registry",
            nl: "Handelsregister",
          },
          description: {
            en: "Formal registration numbers and identifiers.",
            nl: "Formele registratienummers en identificaties.",
          },
          fields: ["registrationNumber", "globalLocationNumber"],
        },
        {
          id: "tax",
          title: {
            en: "Tax",
            nl: "Fiscaal",
          },
          description: {
            en: "Tax registration details used in invoicing and compliance flows.",
            nl: "Fiscale registraties die gebruikt worden in facturatie- en complianceprocessen.",
          },
          fields: ["vatNumber"],
        },
      ],
    },
  ],
  fields: [
    {
      key: "name",
      valueType: "string",
      required: true,
      label: {
        en: "Name",
        nl: "Naam",
      },
      description: {
        en: "Official registered name of the legal entity.",
        nl: "Officieel geregistreerde naam van de rechtspersoon.",
      },
      placeholder: {
        en: "Enter the legal name",
        nl: "Voer de statutaire naam in",
      },
      validation: {
        minLength: {
          value: 1,
          message: {
            en: "Name cannot be empty.",
            nl: "Naam mag niet leeg zijn.",
          },
        },
        maxLength: {
          value: 300,
          message: {
            en: "Name must be at most 300 characters.",
            nl: "Naam mag maximaal 300 tekens bevatten.",
          },
        },
      },
      persisted: {
        column: "name",
        storageClass: "core",
      },
    },
    {
      key: "legalForm",
      valueType: "string",
      label: {
        en: "Legal form",
        nl: "Rechtsvorm",
      },
      description: {
        en: "Legal form of the entity (for example BV, NV, or Stichting).",
        nl: "Rechtsvorm van de entiteit (bijvoorbeeld BV, NV of Stichting).",
      },
      placeholder: {
        en: "Select or enter the legal form",
        nl: "Kies of voer de rechtsvorm in",
      },
      validation: {
        maxLength: 100,
      },
      options: {
        type: "referentiedata",
        referentieGroep: "RECHTSVORM",
      },
      persisted: {
        column: "legal_form",
        storageClass: "core",
      },
      render: {
        component: "ReferenceSelect",
        props: {
          referentieGroep: "RECHTSVORM",
          clearable: true,
        },
      },
    },
    {
      key: "registrationNumber",
      valueType: "string",
      label: {
        en: "Registration number",
        nl: "KvK-nummer",
      },
      description: {
        en: "Chamber of Commerce or company registration number.",
        nl: "Kamer van Koophandel-nummer of handelsregisternummer.",
      },
      placeholder: {
        en: "Enter the registration number",
        nl: "Voer het registratienummer in",
      },
      validation: {
        maxLength: 50,
      },
      persisted: {
        column: "registration_number",
        storageClass: "core",
      },
    },
    {
      key: "vatNumber",
      valueType: "string",
      label: {
        en: "VAT number",
        nl: "BTW-nummer",
      },
      description: {
        en: "Value Added Tax identification number.",
        nl: "BTW-identificatienummer.",
      },
      placeholder: {
        en: "Enter the VAT number",
        nl: "Voer het BTW-nummer in",
      },
      validation: {
        maxLength: 50,
      },
      persisted: {
        column: "vat_number",
        storageClass: "core",
      },
    },
    {
      key: "globalLocationNumber",
      valueType: "string",
      label: {
        en: "Global Location Number",
        nl: "GLN-nummer",
      },
      description: {
        en: "Global Location Number (GLN) for identification in supply chains.",
        nl: "Global Location Number (GLN) voor identificatie in toeleveringsketens.",
      },
      placeholder: {
        en: "Enter the GLN number",
        nl: "Voer het GLN-nummer in",
      },
      validation: {
        maxLength: 13,
      },
      persisted: {
        column: "global_location_number",
        storageClass: "core",
      },
    },
  ],
  actions: [
    {
      id: "submit",
      kind: "submit",
      label: {
        en: "Save legal entity",
        nl: "Rechtspersoon opslaan",
      },
    },
  ],
};

export const FORM_DEFINITION_EXAMPLE = LEGAL_ENTITY_FORM_DEFINITION;
