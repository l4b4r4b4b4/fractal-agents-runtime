"""Graphs — LangGraph agent definitions.

This package contains LangGraph graph factories. Each sub-package
(e.g. ``react_agent``) exposes a ``graph()`` factory that returns a
compiled ``StateGraph`` ready for streaming execution.

Usage::

    from graphs.react_agent import graph

    agent = graph(checkpointer=..., store=...)
"""
