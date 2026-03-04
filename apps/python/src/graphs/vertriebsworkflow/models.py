"""Pydantic-Modelle fuer den Vertriebsworkflow.

Enthaelt alle strukturierten LLM-Outputs:
- IntakeDecision: Stadt-Erkennung + Intent
- ProjectData / FinalProjectData: Projekt-Datenmodelle
- AggregatorProjectOutput: Wrapper fuer Aggregator-Anreicherung
- SearchQueriesOutput / VerifierOutput / WorkerFinalOutput: Worker-Subgraph
"""

from pydantic import BaseModel, Field


# =============================================================================
# Intake
# =============================================================================


class IntakeDecision(BaseModel):
    """Entscheidung des Intake-LLMs ob der Workflow gestartet werden kann."""

    ist_startbereit: bool = Field(
        description="True wenn der User eine Projektsuche starten will UND eine deutsche Stadt erkennbar ist"
    )
    stadt: str | None = Field(
        default=None,
        description="Die extrahierte deutsche Stadt (z.B. 'Muenchen', 'Berlin'). None wenn keine Stadt erkannt.",
    )
    antwort: str = Field(
        description="Antwort an den User. Bei Start: kurze Bestaetigung. Sonst: Nachfrage oder Hilfe."
    )


# =============================================================================
# Projekt-Datenmodelle
# =============================================================================


class ProjectData(BaseModel):
    """Strukturierte Daten eines Immobilienprojekts (Worker-Output)."""

    projektname: str = Field(description="Offizieller Projektname")
    stadt: str = Field(description="Stadt in Deutschland")
    asset_klasse: str = Field(
        description="Asset-Klasse: Buero | Logistik | Hotel | Einzelhandel | Mixed-Use"
    )
    lph_phase: str = Field(
        default="unklar",
        description="HOAI Leistungsphase: LPH 1-3 | LPH 4 | LPH 5 | unklar",
    )
    projektstatus: str = Field(
        default="unklar",
        description="Projektstatus: Vorplanung | Genehmigung | Ausfuehrungsplanung | unklar",
    )
    quellen: list[str] = Field(description="Liste von URLs (min. 1, max. 2)")
    info_qualitaet: str = Field(
        default="niedrig",
        description="Qualitaet der verfuegbaren Informationen: niedrig | mittel | hoch",
    )


AIS_THEMENFELDER = [
    "Technische Due Diligence",
    "ESG / Nachhaltigkeitszertifizierung",
    "Brandschutzkonzepte",
    "Fassadenplanung / -beratung",
    "Bauphysik (Waerme, Schall, Feuchte)",
    "Projektsteuerung / Projektmanagement",
    "Kostenplanung / AVA",
    "SiGeKo / Arbeitssicherheit",
    "Schadstoffsanierung / Rueckbaukonzepte",
    "BIM-Management / Digitalisierung",
    "Energieberatung / Energiekonzepte",
    "Tragwerksplanung (Bestandsbewertung)",
    "Infrastruktur / Erschliessungsplanung",
]


class Ansprechpartner(BaseModel):
    """Kontaktperson bei Projektentwickler oder Investor."""

    name: str = Field(default="unklar", description="Vor- und Nachname")
    rolle: str = Field(default="unklar", description="Position/Rolle")
    firma: str = Field(default="unklar", description="Unternehmen/Organisation")
    email: str = Field(default="unklar", description="E-Mail-Adresse")
    quelle: str = Field(default="", description="Informationsquelle")


class FinalProjectData(BaseModel):
    """Erweitertes Projekt-Datenmodell nach Aggregator-Anreicherung."""

    projektname: str = Field(description="Offizieller Projektname")
    stadt: str = Field(description="Stadt in Deutschland")
    asset_klasse: str = Field(
        description="Asset-Klasse: Buero | Logistik | Hotel | Einzelhandel | Mixed-Use"
    )
    lph_phase: str = Field(default="unklar", description="HOAI Leistungsphase")
    projektstatus: str = Field(default="unklar", description="Projektstatus")
    quellen: list[str] = Field(description="Liste von URLs")
    info_qualitaet: str = Field(default="niedrig", description="Informationsqualitaet")
    groessenordnung: str = Field(
        default="unklar", description="BGF / Einheiten / Investitionsvolumen"
    )
    projektkurzbeschreibung: str = Field(
        default="", description="2-3 Saetze Projektbeschreibung"
    )
    entwickler_investor: str = Field(
        default="unklar", description="Name des Entwicklers/Investors"
    )
    beratungspotenzial: str = Field(
        default="mittel", description="hoch | mittel | gering"
    )
    begruendung_potenzial: str = Field(
        default="", description="Begruendung des Beratungspotenzials"
    )
    ais_themenfelder: list[str] = Field(
        default_factory=list, description="Max. 3 AIS-Themenfelder"
    )
    ansprechpartner: list[Ansprechpartner] = Field(
        default_factory=list, description="Kontaktpersonen"
    )
    ist_relevant: bool = Field(
        default=True, description="False wenn kein echtes Immobilienprojekt"
    )


class AggregatorProjectOutput(BaseModel):
    """Output eines einzelnen Aggregator-LLM-Calls."""

    projekt: FinalProjectData = Field(description="Angereichertes Projekt")


# =============================================================================
# Worker-Subgraph Modelle
# =============================================================================


class SearchQuery(BaseModel):
    """Eine einzelne Such-Query mit Metadata."""

    query_id: str = Field(description="Eindeutige Query-ID (z.B. 'q1_iter1')")
    query_text: str = Field(description="Web-Suchquery")
    reasoning: str = Field(description="Warum diese Query relevant ist")


class SearchQueriesOutput(BaseModel):
    """Output des Worker-Query-Nodes."""

    new_queries: list[SearchQuery] = Field(
        default_factory=list, description="Neue Queries"
    )
    strategy_notes: str = Field(description="Query-Strategie")


class TavilySearchResult(BaseModel):
    """Ergebnis einer einzelnen Tavily-Suche."""

    query_id: str = Field(description="ID der ausgefuehrten Query")
    query_text: str = Field(description="Text der Query")
    results: list[dict] = Field(
        default_factory=list, description="Ergebnisse ueber Threshold"
    )
    filtered_results: list[dict] = Field(
        default_factory=list, description="Ergebnisse unter Threshold"
    )
    filtered_count: int = Field(default=0, description="Anzahl unter Threshold")


class QueryVerdict(BaseModel):
    """Bewertung einer einzelnen Query durch den Verifier."""

    query_id: str = Field(description="ID der bewerteten Query")
    quality: str = Field(description="Quality-Level: 'low', 'medium', 'high'")
    reasoning: str = Field(description="Begruendung")
    improvement_suggestion: str = Field(
        default="", description="Verbesserungsvorschlag"
    )


class VerifierOutput(BaseModel):
    """Output des Verifier-Nodes."""

    query_verdicts: list[QueryVerdict] = Field(description="Bewertung jeder Query")
    overall_reasoning: str = Field(description="Gesamt-Begruendung")


class WorkerFinalOutput(BaseModel):
    """Output der Final Evaluation (Iter2)."""

    task_id: str = Field(description="ID der bearbeiteten Subtask")
    projekte: list[ProjectData] = Field(
        default_factory=list, description="Extrahierte Projekte (max. 5)"
    )
