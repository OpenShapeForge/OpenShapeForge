# Entity-YAML en Web-presentatie

Deze regels gelden voor het ontwerpen van entiteiten en hun Web-presentatie.
Het actuele authoring-schema en de canonieke entity-contracten bepalen de
ondersteunde syntax. De Web-interface definieert geen eigen bedrijfsregels.

## Eerst de entiteit begrijpen

Bepaal betekenis, gebruikers, bron/eigenaar, lifecycle, rechten en de volledige
relatiegraaf. Inventariseer ieder bestaand veld voordat je een scherm ontwerpt.
Behoud die velden in het domein-YAML; presentatie mag een veld weglaten, het
model niet. Vraag vooraf toestemming voor nieuwe zakelijke velden.

Beschrijf wat een gebruiker met dit object wil begrijpen, beoordelen en
bewerken. Maak vervolgens betekenisvolle groepen. Kies de lijstkolommen die
herkenning en vergelijking ondersteunen; zet identiteit en werkelijk nuttige
relaties in de context. Gebruik tabs voor verschillende taken of omvangrijke
categorieen. Een klein object heeft geen kunstmatige tabs nodig.

## Eigenschappen voor handelingen

Onderzoek eerst gewone bewerkbare eigenschappen en bestaande semantische
velden. Publiceren kan bijvoorbeeld een boolean zijn wanneer dat de werkelijke
bedrijfsregel uitdrukt. Conditional visibility is presentatie; cross-field- en
statusregels worden canoniek door de server gehandhaafd. Een nieuwe Operation
is alleen gerechtvaardigd door een echte taak die niet correct als gewone
bewerking past, bijvoorbeeld transactionele effecten of een externe workflow.
Bespreek dat concrete verschil vooraf; verzin geen actie voor een CRUD-scherm.

## Figma en gedeelde renderers

Gebruik het exacte file/node-id, lees design context en de screenshot en
inspecteer de relevante componenten en varianten. Bestaande patronen zijn
bewijs van ontwerpintentie, voorbeeldwaarden zijn geen domeinregels. Inspecteer
de werkelijk geinstalleerde Battery API, stories en componentcode. Alle visuele
elementen gebruiken ondersteunde Battery-componenten. Een ontbrekende visuele
capability vereist een expliciet ontwerpbesluit; gekopieerd Figma-JSX vervangt
dat niet.

Waar een volledig scherm is uitgewerkt, implementeer dat ontwerp. Waar alleen
voorbeelden beschikbaar zijn, ontwerp vanuit de entiteit met YAML en de
beschikbare renderers. Pas Relatie niet mechanisch op elke entiteit toe.
Context, hoofdinhoud, relevante relaties, aangeboden Operations en open werk
hebben verschillende doelen. Toon open werk alleen uit echte taken/statussen;
een collectie-aantal maakt een relatie niet urgent. Toon geen fictieve acties,
waarschuwingen, portretten, bedragen, tellingen of activiteit.

## Concrete configuratie en bewijs

Toon het concrete YAML-diff in producttaal voordat je implementeert. Benoem
ondersteunde syntax en eventuele gedeelde contractuitbreidingen afzonderlijk.
Gebruik dunne hosts: domeincontracten horen bij hun OSF/plugin-eigenaar,
herbruikbare presentatie bij Battery en de gedeelde renderer.

Controleer veldbehoud, labels, rechten, paginering, sortering, loading/empty/error,
conflict en responsive gedrag. Compileer deterministisch en toets de gewijzigde
ingelogde browserstroom met rapport, screenshots en video. Technische checks
bewijzen geen visuele productacceptatie. Rapporteer wat actief werkt en wat nog
ontbreekt; een inventaris of een gegenereerde route is geen adoptiebewijs.

Een contextregel mag `records` met een pad van een tot vier bestaande
relaties selecteren. De compiler controleert iedere stap, het leescontract en
het tekstveld voor de naam. Een terminale `when`-selectie verwijst alleen naar
bestaande scalaire velden; dit is presentatie, geen toegangsbeleid. Behoud alle
passende resultaten en meld onvolledige/paginagegevens. Een statuskleur volgt
een expliciete mapping van het bestaande statusveld; onbekend blijft neutraal.
