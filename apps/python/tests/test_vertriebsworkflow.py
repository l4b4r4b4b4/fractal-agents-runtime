"""Schneller Integrationstest: Vertriebsworkflow ueber die Runtime-API.

Erstellt Assistant + Thread, startet einen Run mit einer Stadt
und gibt die SSE-Events in Echtzeit aus.

Die Runtime erwartet Auth (require_user) auch bei deaktiviertem Supabase.
Wir erzeugen ein lokales HS256-JWT mit dem SUPABASE_JWT_SECRET aus der .env.
"""

import base64
import hashlib
import hmac
import json
import os
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

BASE = "http://localhost:8081"
TIMEOUT = httpx.Timeout(300.0, connect=10.0)


def _make_dummy_jwt(secret: str) -> str:
    """Erzeugt ein minimales HS256-JWT fuer lokale Tests."""
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "typ": "JWT"}).encode()
    ).rstrip(b"=").decode()

    payload = base64.urlsafe_b64encode(
        json.dumps({
            "sub": "00000000-0000-0000-0000-000000000000",
            "email": "test@local.dev",
            "exp": int(time.time()) + 3600,
            "role": "authenticated",
        }).encode()
    ).rstrip(b"=").decode()

    sig_input = f"{header}.{payload}".encode("ascii")
    signature = hmac.new(secret.encode(), sig_input, hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()

    return f"{header}.{payload}.{sig_b64}"


def main():
    jwt_secret = os.getenv("SUPABASE_JWT_SECRET", "")
    headers = {}
    if jwt_secret:
        token = _make_dummy_jwt(jwt_secret)
        headers["Authorization"] = f"Bearer {token}"
        print(f"[Auth] JWT mit SUPABASE_JWT_SECRET erzeugt")
    else:
        print("[Auth] Kein SUPABASE_JWT_SECRET — teste ohne Auth-Header")

    client = httpx.Client(base_url=BASE, timeout=TIMEOUT, headers=headers)

    # 1. Assistant erstellen
    print("[1] Assistant erstellen...")
    resp = client.post("/assistants", json={
        "graph_id": "vertriebsworkflow",
        "config": {"configurable": {}},
        "metadata": {"name": "Vertriebsworkflow Test"},
    })
    print(f"    Status: {resp.status_code}")
    print(f"    Body: {resp.text[:500]}")
    resp.raise_for_status()
    assistant = resp.json()
    assistant_id = assistant["assistant_id"]
    print(f"    assistant_id = {assistant_id}")

    # 2. Thread erstellen
    print("[2] Thread erstellen...")
    resp = client.post("/threads", json={})
    resp.raise_for_status()
    thread = resp.json()
    thread_id = thread["thread_id"]
    print(f"    thread_id = {thread_id}")

    # 3. Run starten (Streaming)
    print("[3] Run starten (Stadt: Muenchen)...")
    print("-" * 60)

    with httpx.Client(base_url=BASE, timeout=TIMEOUT, headers=headers) as stream_client:
        with stream_client.stream(
            "POST",
            f"/threads/{thread_id}/runs/stream",
            json={
                "assistant_id": assistant_id,
                "input": {
                    "messages": [
                        {"role": "human", "content": "Suche Projekte in Muenchen"}
                    ]
                },
                "stream_mode": ["updates"],
            },
        ) as response:
            response.raise_for_status()
            event_type = None
            for line in response.iter_lines():
                if line.startswith("event:"):
                    event_type = line[6:].strip()
                elif line.startswith("data:"):
                    data_str = line[5:].strip()
                    if data_str:
                        try:
                            data = json.loads(data_str)
                            print(f"\n[SSE] event={event_type}")

                            if event_type == "updates" and isinstance(data, dict):
                                for node_name, node_data in data.items():
                                    msgs = node_data.get("messages", []) if isinstance(node_data, dict) else []
                                    if msgs:
                                        for m in msgs:
                                            content = m.get("content", "") if isinstance(m, dict) else str(m)
                                            print(f"  [{node_name}] {content[:200]}")
                                    else:
                                        keys = list(node_data.keys()) if isinstance(node_data, dict) else []
                                        print(f"  [{node_name}] keys={keys}")

                            elif event_type == "values":
                                if isinstance(data, dict) and "final_projects" in data:
                                    projects = data["final_projects"]
                                    print(f"  FINAL: {len(projects)} Projekte")
                                    for p in projects[:5]:
                                        name = p.get("projektname", "?")
                                        ak = p.get("asset_klasse", "?")
                                        pot = p.get("beratungspotenzial", "?")
                                        print(f"    - {name} ({ak}, Potenzial: {pot})")

                            elif event_type == "error":
                                print(f"  ERROR: {json.dumps(data, indent=2, ensure_ascii=False)}")

                        except json.JSONDecodeError:
                            print(f"  [raw] {data_str[:200]}")

    print("\n" + "-" * 60)
    print("Test abgeschlossen.")


if __name__ == "__main__":
    main()
