#!/usr/bin/env python3
"""Seed a ChromaDB test collection with embedded documents for RAG testing.

Usage:
    python scripts/seed_chromadb_test.py

    # Custom URLs:
    CHROMADB_URL=http://localhost:8100 TEI_URL=http://localhost:8011 python scripts/seed_chromadb_test.py

This script:
  1. Connects to a ChromaDB instance
  2. Creates a collection named repo_test-rag-archive
  3. Embeds a set of German real-estate / facility-management test documents via TEI
  4. Upserts them into the collection with realistic metadata

The resulting collection can be used to test the runtime's search_archives tool
by configuring an agent with:

    "rag_config": {
        "archives": [{
            "name": "Test RAG Archive",
            "collection_name": "repo_test-rag-archive",
            "chromadb_url": "http://chromadb:8000",
            "embedding_model": "jinaai/jina-embeddings-v2-base-de"
        }]
    }
"""

from __future__ import annotations

import os
import sys
from urllib.parse import urlparse

import chromadb
import httpx

CHROMADB_URL = os.environ.get("CHROMADB_URL", "http://localhost:8100")
TEI_URL = os.environ.get("TEI_URL", "http://localhost:8011")
EMBEDDING_MODEL = "jinaai/jina-embeddings-v2-base-de"
COLLECTION_NAME = "repo_test-rag-archive"

# ---------------------------------------------------------------------------
# Test documents — German real-estate / facility-management content
# ---------------------------------------------------------------------------

TEST_DOCUMENTS: list[dict] = [
    {
        "id": "doc-001:chunk:0",
        "text": (
            "Die jährliche Wartung der Heizungsanlage im Erdgeschoss wurde am "
            "15. Januar 2025 durchgeführt. Der Brenner wurde gereinigt, die "
            "Abgaswerte gemessen und für einwandfrei befunden. Der Heizungstechniker "
            "empfiehlt den Austausch des Ausdehnungsgefäßes innerhalb der nächsten "
            "12 Monate, da leichte Druckverluste festgestellt wurden."
        ),
        "metadata": {
            "document_id": "doc-001",
            "repository_id": "test-rag-archive",
            "organization_id": "org-test",
            "layer": "chunk",
            "char_start": 0,
            "char_end": 380,
            "token_count": 62,
            "text_preview": "Die jährliche Wartung der Heizungsanlage im Erdgeschoss",
            "page_number": 1,
            "section_heading": "Wartungsbericht Heizung 2025",
        },
    },
    {
        "id": "doc-001:chunk:1",
        "text": (
            "Die Heizkostenabrechnung für das Geschäftsjahr 2024 ergab einen "
            "Gesamtverbrauch von 145.000 kWh Erdgas. Im Vergleich zum Vorjahr "
            "ist dies ein Rückgang von 8%, was auf die im Sommer 2024 durchgeführte "
            "Fassadendämmung zurückzuführen ist. Die Kosten pro Quadratmeter "
            "betragen 12,40 EUR bei einer Gesamtfläche von 2.800 m²."
        ),
        "metadata": {
            "document_id": "doc-001",
            "repository_id": "test-rag-archive",
            "organization_id": "org-test",
            "layer": "chunk",
            "char_start": 380,
            "char_end": 720,
            "token_count": 58,
            "text_preview": "Die Heizkostenabrechnung für das Geschäftsjahr 2024",
            "page_number": 2,
            "section_heading": "Heizkostenabrechnung 2024",
        },
    },
    {
        "id": "doc-002:chunk:0",
        "text": (
            "Gemäß der Brandschutzordnung Teil B ist die maximale Belegung des "
            "Konferenzraums im 3. OG auf 45 Personen begrenzt. Fluchtwege müssen "
            "jederzeit freigehalten werden. Die Brandschutztüren in den Treppenhäusern "
            "sind selbstschließend und dürfen nicht verkeilt werden. Die letzte "
            "Brandschutzbegehung fand am 03. März 2025 statt — alle Mängel aus der "
            "Vorbegehung wurden behoben."
        ),
        "metadata": {
            "document_id": "doc-002",
            "repository_id": "test-rag-archive",
            "organization_id": "org-test",
            "layer": "chunk",
            "char_start": 0,
            "char_end": 420,
            "token_count": 70,
            "text_preview": "Gemäß der Brandschutzordnung Teil B ist die maximale",
            "page_number": 1,
            "section_heading": "Brandschutzordnung Teil B",
        },
    },
    {
        "id": "doc-003:chunk:0",
        "text": (
            "Der Mietvertrag für die Bürofläche im 2. OG (Einheit 2.01, 350 m²) "
            "wurde am 01. April 2024 mit der Firma TechStart GmbH geschlossen. "
            "Die monatliche Kaltmiete beträgt 4.200 EUR, zuzüglich Nebenkosten von "
            "1.050 EUR. Der Vertrag hat eine Laufzeit von 5 Jahren mit einer "
            "Verlängerungsoption von 2x3 Jahren. Die Kaution in Höhe von drei "
            "Monatsmieten (12.600 EUR) wurde hinterlegt."
        ),
        "metadata": {
            "document_id": "doc-003",
            "repository_id": "test-rag-archive",
            "organization_id": "org-test",
            "layer": "chunk",
            "char_start": 0,
            "char_end": 430,
            "token_count": 75,
            "text_preview": "Der Mietvertrag für die Bürofläche im 2. OG",
            "page_number": 1,
            "section_heading": "Mietvertrag Einheit 2.01",
        },
    },
    {
        "id": "doc-003:chunk:1",
        "text": (
            "Die Nebenkostenabrechnung für 2024 weist folgende Positionen auf: "
            "Grundsteuer 2.100 EUR, Gebäudeversicherung 3.400 EUR, Hausverwaltung "
            "4.800 EUR, Aufzugwartung 1.200 EUR, Treppenhausreinigung 2.400 EUR, "
            "Müllabfuhr 1.800 EUR, Wasserversorgung 3.600 EUR, Allgemeinstrom "
            "1.100 EUR. Die Gesamtnebenkosten betragen 20.400 EUR, was einer "
            "Umlage von 7,29 EUR/m² entspricht."
        ),
        "metadata": {
            "document_id": "doc-003",
            "repository_id": "test-rag-archive",
            "organization_id": "org-test",
            "layer": "chunk",
            "char_start": 430,
            "char_end": 830,
            "token_count": 80,
            "text_preview": "Die Nebenkostenabrechnung für 2024 weist folgende",
            "page_number": 3,
            "section_heading": "Nebenkostenabrechnung 2024",
        },
    },
    {
        "id": "doc-004:chunk:0",
        "text": (
            "Das Dach des Gebäudes wurde im September 2023 komplett saniert. "
            "Die Arbeiten umfassten die Erneuerung der Dachabdichtung, den Austausch "
            "der Wärmedämmung (von 120 mm auf 200 mm Mineralwolle) sowie die "
            "Installation einer neuen Dachrinnenheizung. Die Gesamtkosten betrugen "
            "187.500 EUR. Die Gewährleistungsfrist für die Dachabdichtung beträgt "
            "10 Jahre (bis September 2033)."
        ),
        "metadata": {
            "document_id": "doc-004",
            "repository_id": "test-rag-archive",
            "organization_id": "org-test",
            "layer": "chunk",
            "char_start": 0,
            "char_end": 410,
            "token_count": 68,
            "text_preview": "Das Dach des Gebäudes wurde im September 2023",
            "page_number": 1,
            "section_heading": "Dachsanierung 2023",
        },
    },
    {
        "id": "doc-005:chunk:0",
        "text": (
            "Der Aufzug (Baujahr 2018, Hersteller Schindler, Typ 3300) wird "
            "halbjährlich durch die TÜV Süd geprüft. Die letzte Hauptprüfung "
            "erfolgte am 22. November 2024 — das Prüfergebnis war mangelfrei. "
            "Die nächste Hauptprüfung ist für Mai 2025 vorgesehen. Der "
            "Wartungsvertrag mit Schindler (Vertragsnr. DE-2024-78432) läuft bis "
            "Dezember 2026 und kostet 3.600 EUR jährlich."
        ),
        "metadata": {
            "document_id": "doc-005",
            "repository_id": "test-rag-archive",
            "organization_id": "org-test",
            "layer": "chunk",
            "char_start": 0,
            "char_end": 400,
            "token_count": 72,
            "text_preview": "Der Aufzug (Baujahr 2018, Hersteller Schindler",
            "page_number": 1,
            "section_heading": "Aufzugprüfbericht",
        },
    },
    {
        "id": "doc-006:chunk:0",
        "text": (
            "Die Parkplatzordnung regelt die Nutzung der 42 Stellplätze in der "
            "Tiefgarage. Stellplätze 1-10 sind den Mietern im Erdgeschoss "
            "zugeordnet, 11-30 werden monatlich für 85 EUR vermietet, und 31-42 "
            "stehen Besuchern zur Verfügung. Elektrofahrzeuge können an den "
            "Ladestationen auf Platz 5, 15, 25 und 35 geladen werden (Abrechnung "
            "über die Nebenkostenumlage, aktuell 0,32 EUR/kWh)."
        ),
        "metadata": {
            "document_id": "doc-006",
            "repository_id": "test-rag-archive",
            "organization_id": "org-test",
            "layer": "chunk",
            "char_start": 0,
            "char_end": 420,
            "token_count": 74,
            "text_preview": "Die Parkplatzordnung regelt die Nutzung der 42",
            "page_number": 1,
            "section_heading": "Parkplatzordnung Tiefgarage",
        },
    },
]


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts via the TEI /v1/embeddings endpoint."""
    response = httpx.post(
        f"{TEI_URL.rstrip('/')}/v1/embeddings",
        json={"model": EMBEDDING_MODEL, "input": texts},
        timeout=30.0,
    )
    response.raise_for_status()
    data = response.json()
    # Sort by index to guarantee order matches input
    sorted_data = sorted(data["data"], key=lambda item: item["index"])
    return [item["embedding"] for item in sorted_data]


def main() -> int:
    parsed = urlparse(CHROMADB_URL)
    host = parsed.hostname or "localhost"
    port = parsed.port or 8000
    ssl = parsed.scheme == "https"

    print(f"Connecting to ChromaDB at {CHROMADB_URL} ...")
    client = chromadb.HttpClient(host=host, port=port, ssl=ssl)
    heartbeat = client.heartbeat()
    print(f"  ChromaDB heartbeat: {heartbeat}")

    print(f"\nEmbedding {len(TEST_DOCUMENTS)} documents via TEI at {TEI_URL} ...")
    texts = [doc["text"] for doc in TEST_DOCUMENTS]
    embeddings = embed_texts(texts)
    print(f"  Embedding dimensions: {len(embeddings[0])}")

    print(f"\nCreating/resetting collection: {COLLECTION_NAME} ...")
    # Delete if exists, then create fresh
    try:
        client.delete_collection(name=COLLECTION_NAME)
        print(f"  Deleted existing collection {COLLECTION_NAME}")
    except Exception:
        pass

    collection = client.create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )
    print(f"  Created collection {COLLECTION_NAME} (cosine distance)")

    print(f"\nUpserting {len(TEST_DOCUMENTS)} documents ...")
    collection.upsert(
        ids=[doc["id"] for doc in TEST_DOCUMENTS],
        documents=texts,
        embeddings=embeddings,
        metadatas=[doc["metadata"] for doc in TEST_DOCUMENTS],
    )

    # Verify
    count = collection.count()
    print(f"  Collection count: {count}")

    # Quick test query
    print("\nTest query: 'Wartung Heizung' ...")
    test_embedding = embed_texts(["Wartung Heizung"])[0]
    results = collection.query(
        query_embeddings=[test_embedding],
        n_results=3,
        where={"layer": "chunk"},
        include=["documents", "metadatas", "distances"],
    )
    print(f"  Top {len(results['documents'][0])} results:")
    for i, (doc, meta, dist) in enumerate(
        zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        )
    ):
        print(
            f"    [{i + 1}] distance={dist:.4f}  section={meta.get('section_heading', '?')}"
        )
        print(f"        {doc[:80]}...")

    print(f"\n✅ ChromaDB seeded successfully!")
    print(f"   Collection: {COLLECTION_NAME}")
    print(f"   Documents:  {count}")
    print(f"\n   Use this rag_config in your agent:")
    print(
        f'   {{"archives": [{{"name": "Test RAG Archive", "collection_name": "{COLLECTION_NAME}", "chromadb_url": "http://chromadb:8000", "embedding_model": "{EMBEDDING_MODEL}"}}]}}'
    )

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except httpx.ConnectError as exc:
        print(f"\n❌ Connection failed: {exc}", file=sys.stderr)
        print("   Make sure ChromaDB and TEI are running:", file=sys.stderr)
        print(
            "     docker compose up -d chromadb embeddings --scale chromadb=1 --scale embeddings=1",
            file=sys.stderr,
        )
        sys.exit(1)
    except Exception as exc:
        print(f"\n❌ Error: {exc}", file=sys.stderr)
        sys.exit(1)
