"""Vertriebsworkflow — Immobilien-Projektsuche.

Sucht automatisiert Immobilien-Projektentwicklungen in deutschen Staedten
ueber 5 Asset-Klassen (Buero, Logistik, Hotel, Einzelhandel, Mixed-Use).

Flow: intake (LLM) -> analyzer -> worker (5x parallel) -> collect (Dedup)

Usage::

    from graphs.vertriebsworkflow import graph

    agent = await graph(config, checkpointer=cp, store=st)
    result = await agent.ainvoke(
        {"messages": [HumanMessage(content="Suche Projekte in Muenchen")]},
        config,
    )
"""

from graphs.vertriebsworkflow.graph import graph

__all__ = ["graph"]
