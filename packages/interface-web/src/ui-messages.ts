// SPDX-License-Identifier: BUSL-1.1
import { normalizeUiLocale, type UiLocale } from "./localization.js";

export const uiMessages = {
  "Unavailable": {
    "en": "Unavailable",
    "nl": "Niet beschikbaar"
  },
  "Loading data…": {
    "en": "Loading data…",
    "nl": "Gegevens laden…"
  },
  "The server returned the same page again.": {
    "en": "The server returned the same page again.",
    "nl": "De server gaf dezelfde lijstpagina opnieuw terug."
  },
  "Yes": {
    "en": "Yes",
    "nl": "Ja"
  },
  "No": {
    "en": "No",
    "nl": "Nee"
  },
  "Create": {
    "en": "Create",
    "nl": "Aanmaken"
  },
  "Search all accessible": {
    "en": "Search all accessible",
    "nl": "Alle toegankelijke"
  },
  "records…": {
    "en": "records…",
    "nl": "doorzoeken…"
  },
  "Available list actions": {
    "en": "Available list actions",
    "nl": "Beschikbare lijstacties"
  },
  "No search results.": {
    "en": "No search results.",
    "nl": "Geen zoekresultaten."
  },
  "Action": {
    "en": "Action",
    "nl": "Actie"
  },
  "Open": {
    "en": "Open",
    "nl": "Openen"
  },
  "Loading more…": {
    "en": "Loading more…",
    "nl": "Meer laden…"
  },
  "Load more": {
    "en": "Load more",
    "nl": "Meer laden"
  },
  "of": {
    "en": "of",
    "nl": "van"
  },
  "The choices could not be fully loaded.": {
    "en": "The choices could not be fully loaded.",
    "nl": "De keuzelijst kon niet volledig worden geladen."
  },
  "The available choices could not be loaded.": {
    "en": "The available choices could not be loaded.",
    "nl": "De geautoriseerde keuzelijst kon niet worden geladen."
  },
  "Loading choices…": {
    "en": "Loading choices…",
    "nl": "Keuzes laden…"
  },
  "Choose a value": {
    "en": "Choose a value",
    "nl": "Kies een waarde"
  },
  "No available choices": {
    "en": "No available choices",
    "nl": "Geen toegankelijke keuzes"
  },
  "Reload choices": {
    "en": "Reload choices",
    "nl": "Keuzes opnieuw laden"
  },
  "You cannot create a record at this time.": {
    "en": "You cannot create a record at this time.",
    "nl": "U mag op dit moment geen record aanmaken."
  },
  "Working…": {
    "en": "Working…",
    "nl": "Bezig…"
  },
  "Cancel": {
    "en": "Cancel",
    "nl": "Annuleren"
  },
  "Loading related data…": {
    "en": "Loading related data…",
    "nl": "Gerelateerde gegevens laden…"
  },
  "No related records yet.": {
    "en": "No related records yet.",
    "nl": "Nog geen gerelateerde records."
  },
  "Edit": {
    "en": "Edit",
    "nl": "Wijzigen"
  },
  "Detail views": {
    "en": "Detail views",
    "nl": "Detailweergaven"
  },
  "Save": {
    "en": "Save",
    "nl": "Opslaan"
  },
  "This tab has no editable fields.": {
    "en": "This tab has no editable fields.",
    "nl": "Deze tab bevat geen wijzigbare velden."
  },
  "Record context": {
    "en": "Record context",
    "nl": "Recordcontext"
  },
  "Context": {
    "en": "Context",
    "nl": "Context"
  },
  "Not linked": {
    "en": "Not linked",
    "nl": "Niet gekoppeld"
  },
  "Available actions": {
    "en": "Available actions",
    "nl": "Beschikbare acties"
  },
  "Take action": {
    "en": "Take action",
    "nl": "Nu regelen"
  },
  "You are editing this record. The edit lock remains active while you work in this form.": {
    "en": "You are editing this record. The edit lock remains active while you work in this form.",
    "nl": "U bewerkt dit record. De bewerkingslease blijft alleen actief zolang u in dit formulier werkt."
  },
  "You are editing this record. On saving, the server checks whether it has changed.": {
    "en": "You are editing this record. On saving, the server checks whether it has changed.",
    "nl": "U bewerkt dit record. Bij opslaan controleert de server of het intussen is gewijzigd."
  },
  "You are editing this record.": {
    "en": "You are editing this record.",
    "nl": "U bewerkt dit record."
  },
  "Opening editor…": {
    "en": "Opening editor…",
    "nl": "Bewerkmodus openen…"
  },
  "Loading confirmation…": {
    "en": "Loading confirmation…",
    "nl": "Bevestiging ophalen…"
  },
  "Delete": {
    "en": "Delete",
    "nl": "Verwijderen"
  },
  "Confirm deletion": {
    "en": "Confirm deletion",
    "nl": "Verwijderen bevestigen"
  },
  "Enter the current value of": {
    "en": "Enter the current value of",
    "nl": "Typ de actuele waarde van"
  },
  "to permanently delete this record.": {
    "en": "to permanently delete this record.",
    "nl": "om dit record definitief te verwijderen."
  },
  "This confirmation expires at": {
    "en": "This confirmation expires at",
    "nl": "Deze bevestiging verloopt om"
  },
  "Deleting…": {
    "en": "Deleting…",
    "nl": "Verwijderen…"
  },
  "Delete permanently": {
    "en": "Delete permanently",
    "nl": "Definitief verwijderen"
  },
  "No edit or delete actions are available.": {
    "en": "No edit or delete actions are available.",
    "nl": "Er zijn geen wijzig- of verwijderacties aangeboden."
  },
  "No data available.": {
    "en": "No data available.",
    "nl": "Geen gegevens beschikbaar."
  },
  "The editor closed because the lock expired or you were inactive.": {
    "en": "The editor closed because the lock expired or you were inactive.",
    "nl": "De bewerkmodus is gesloten omdat de vergrendeling is verlopen of u niet meer actief was."
  },
  "The edit lock could not be renewed.": {
    "en": "The edit lock could not be renewed.",
    "nl": "De bewerkingslease kon niet worden verlengd."
  },
  "The editor could not be opened.": {
    "en": "The editor could not be opened.",
    "nl": "De bewerkmodus kon niet worden geopend."
  },
  "The confirmation does not match the version you viewed.": {
    "en": "The confirmation does not match the version you viewed.",
    "nl": "De bevestiging hoort niet bij de versie die u hebt bekeken."
  },
  "The confirmation could not be loaded.": {
    "en": "The confirmation could not be loaded.",
    "nl": "De bevestiging kon niet worden opgehaald."
  },
  "Deletion could not be prepared.": {
    "en": "Deletion could not be prepared.",
    "nl": "De verwijderactie kon niet worden voorbereid."
  },
  "Action result": {
    "en": "Action result",
    "nl": "Actieresultaat"
  },
  "Back to record": {
    "en": "Back to record",
    "nl": "Terug naar record"
  },
  "Back to list": {
    "en": "Back to list",
    "nl": "Terug naar lijst"
  },
  "Action completed.": {
    "en": "Action completed.",
    "nl": "Actie uitgevoerd."
  },
  "View source data": {
    "en": "View source data",
    "nl": "Brongegevens bekijken"
  },
  "The file could not be uploaded.": {
    "en": "The file could not be uploaded.",
    "nl": "Het bestand kon niet worden geüpload."
  },
  "Uploading file…": {
    "en": "Uploading file…",
    "nl": "Bestand uploaden…"
  },
  "File ready to attach.": {
    "en": "File ready to attach.",
    "nl": "Bestand gereed om te koppelen."
  },
  "Remove file": {
    "en": "Remove file",
    "nl": "Bestand verwijderen"
  },
  "Choose a variant": {
    "en": "Choose a variant",
    "nl": "Kies een variant"
  },
  "Remove item": {
    "en": "Remove item",
    "nl": "Regel verwijderen"
  },
  ": add item": {
    "en": ": add item",
    "nl": ": regel toevoegen"
  },
  "Add item": {
    "en": "Add item",
    "nl": "Regel toevoegen"
  },
  "Free structured data": {
    "en": "Free structured data",
    "nl": "Vrije gestructureerde gegevens"
  },
  "The action closed because the lock expired or you were inactive.": {
    "en": "The action closed because the lock expired or you were inactive.",
    "nl": "De actie is gesloten omdat de vergrendeling is verlopen of u niet meer actief was."
  },
  "The lock could not be renewed.": {
    "en": "The lock could not be renewed.",
    "nl": "De vergrendeling kon niet worden verlengd."
  },
  "This action is not linked to this record. Reload the record.": {
    "en": "This action is not linked to this record. Reload the record.",
    "nl": "De server heeft deze actie niet aan dit record gekoppeld. Laad het record opnieuw."
  },
  "This record has changed. Reload it before editing.": {
    "en": "This record has changed. Reload it before editing.",
    "nl": "Dit record is intussen gewijzigd. Laad het opnieuw voordat u gaat bewerken."
  },
  "The current record version is missing. Reload the record.": {
    "en": "The current record version is missing. Reload the record.",
    "nl": "De actuele recordversie ontbreekt. Laad het record opnieuw."
  },
  "The action could not be opened.": {
    "en": "The action could not be opened.",
    "nl": "De actie kon niet worden geopend."
  },
  "Confirm that you want to perform this action first.": {
    "en": "Confirm that you want to perform this action first.",
    "nl": "Bevestig eerst dat u deze actie wilt uitvoeren."
  },
  "The document has been downloaded.": {
    "en": "The document has been downloaded.",
    "nl": "Het document is gedownload."
  },
  "The result is not yet known.": {
    "en": "The result is not yet known.",
    "nl": "Het resultaat is nog niet bekend."
  },
  "The action was not completed.": {
    "en": "The action was not completed.",
    "nl": "De actie is niet uitgevoerd."
  },
  "The linked source record could not be read.": {
    "en": "The linked source record could not be read.",
    "nl": "Het gekoppelde bronrecord kon niet worden gelezen."
  },
  "I confirm that I want to perform this action.": {
    "en": "I confirm that I want to perform this action.",
    "nl": "Ik bevestig dat ik deze actie wil uitvoeren."
  },
  "The original request is retained. Check its result; this action cannot safely be repeated.": {
    "en": "The original request is retained. Check its result; this action cannot safely be repeated.",
    "nl": "De oorspronkelijke opdracht blijft bewaard. Controleer het resultaat; deze actie kan niet veilig opnieuw worden uitgevoerd."
  },
  "The original request is retained. Retrying retrieves the result of that same request.": {
    "en": "The original request is retained. Retrying retrieves the result of that same request.",
    "nl": "De oorspronkelijke opdracht blijft bewaard. Opnieuw proberen vraagt het resultaat van diezelfde opdracht op."
  },
  "Retry": {
    "en": "Retry",
    "nl": "Opnieuw proberen"
  },
  "Confirm and run": {
    "en": "Confirm and run",
    "nl": "Bevestigen en uitvoeren"
  },
  "Run": {
    "en": "Run",
    "nl": "Uitvoeren"
  },
  "Not entered": {
    "en": "Not entered",
    "nl": "Niet ingevuld"
  },
  "No data": {
    "en": "No data",
    "nl": "Geen gegevens"
  },
  "Field": {
    "en": "Field",
    "nl": "Veld"
  },
  "Type": {
    "en": "Type",
    "nl": "Type"
  },
  "Required": {
    "en": "Required",
    "nl": "Verplicht"
  },
  "Not specified": {
    "en": "Not specified",
    "nl": "Niet opgegeven"
  },
  "Details": {
    "en": "Details",
    "nl": "Details"
  },
  "The required instructions could not be loaded.": {
    "en": "The required instructions could not be loaded.",
    "nl": "De vereiste instructies konden niet worden geladen."
  },
  "Read this first": {
    "en": "Read this first",
    "nl": "Lees dit eerst"
  },
  "Read these instructions before creating": {
    "en": "Read these instructions before creating",
    "nl": "Lees deze instructies voordat u"
  },
  ".": {
    "en": ".",
    "nl": "aanmaakt."
  },
  "Loading instructions…": {
    "en": "Loading instructions…",
    "nl": "Instructies laden…"
  },
  "Continue to form": {
    "en": "Continue to form",
    "nl": "Doorgaan naar formulier"
  },
  "Your answer": {
    "en": "Your answer",
    "nl": "Uw antwoord"
  },
  "Choose one of the available actions.": {
    "en": "Choose one of the available actions.",
    "nl": "Kies een van de aangeboden acties."
  },
  "Your answer could not be sent.": {
    "en": "Your answer could not be sent.",
    "nl": "Uw antwoord kon niet worden verstuurd."
  },
  "Sending…": {
    "en": "Sending…",
    "nl": "Versturen…"
  },
  "Send": {
    "en": "Send",
    "nl": "Versturen"
  },
  "This offer has expired. Reload the available actions.": {
    "en": "This offer has expired. Reload the available actions.",
    "nl": "Dit aanbod is verlopen. Haal de actuele beschikbare acties opnieuw op."
  },
  "Notifications": {
    "en": "Notifications",
    "nl": "Notificaties"
  },
  "Account": {
    "en": "Account",
    "nl": "Account"
  },
  "Profile": {
    "en": "Profile",
    "nl": "Profiel"
  },
  "Settings": {
    "en": "Settings",
    "nl": "Instellingen"
  },
  "Sign out": {
    "en": "Sign out",
    "nl": "Uitloggen"
  },
  "Personal menu": {
    "en": "Personal menu",
    "nl": "Persoonlijk menu"
  },
  "KEY FACTS": {
    "en": "KEY FACTS",
    "nl": "KENMERKEN"
  }
} as const;

export function uiMessage(locale: string, key: keyof typeof uiMessages): string { return uiMessages[key][normalizeUiLocale(locale)]; }
