"""Unit tests for _normalise_namespace() and store namespace consistency.

Validates that the namespace normalisation helper in postgres_storage.py
correctly converts both string and list inputs to a canonical list[str]
format, ensuring GET/DELETE (query param strings) produce the same
Postgres-compatible format as PUT/search (JSON body lists).

Reference: .agent/bugs/store-get-delete-namespace-mismatch.md
"""

import pytest

from server.postgres_storage import _normalise_namespace


class TestNormaliseNamespaceStringInput:
    """Test _normalise_namespace() with string inputs (query param path)."""

    def test_single_segment_string_becomes_single_element_list(self) -> None:
        """A plain string like 'preferences' wraps to ['preferences']."""
        result = _normalise_namespace("preferences")

        assert result == ["preferences"]

    def test_dotted_string_stays_as_single_element(self) -> None:
        """A dot-separated string is NOT split — it stays as one segment.

        Namespace segmentation is the caller's responsibility. The helper
        only wraps bare strings; it does not parse them.
        """
        result = _normalise_namespace("users.profiles")

        assert result == ["users.profiles"]

    def test_empty_string_wraps_to_list(self) -> None:
        """An empty string wraps to a single-element list with empty string.

        Validation (rejecting empty namespaces) is the route handler's job,
        not the normalisation helper's.
        """
        result = _normalise_namespace("")

        assert result == [""]

    def test_string_with_spaces_preserved(self) -> None:
        """Whitespace in namespace strings is preserved as-is."""
        result = _normalise_namespace("my namespace")

        assert result == ["my namespace"]

    def test_string_with_curly_braces_not_special(self) -> None:
        """A string that looks like a Postgres array literal is NOT parsed.

        The string '{preferences}' should wrap to ['{preferences}'], not
        be interpreted as a Postgres array.
        """
        result = _normalise_namespace("{preferences}")

        assert result == ["{preferences}"]


class TestNormaliseNamespaceListInput:
    """Test _normalise_namespace() with list inputs (JSON body path)."""

    def test_single_element_list_returned_as_is(self) -> None:
        """A list like ['preferences'] passes through unchanged."""
        result = _normalise_namespace(["preferences"])

        assert result == ["preferences"]

    def test_multi_segment_list_preserved(self) -> None:
        """A multi-segment namespace like ['org', 'user', 'agent', 'tokens']."""
        result = _normalise_namespace(["org", "user", "agent", "tokens"])

        assert result == ["org", "user", "agent", "tokens"]

    def test_empty_list_returned_as_is(self) -> None:
        """An empty list passes through (validation is the caller's job)."""
        result = _normalise_namespace([])

        assert result == []

    def test_list_with_single_empty_string(self) -> None:
        """A list containing an empty string passes through."""
        result = _normalise_namespace([""])

        assert result == [""]

    def test_two_segment_namespace(self) -> None:
        """A two-segment namespace like ['context', 'properties']."""
        result = _normalise_namespace(["context", "properties"])

        assert result == ["context", "properties"]


class TestNormaliseNamespaceReturnType:
    """Verify return type is always a fresh list (not a reference to input)."""

    def test_string_input_returns_list_type(self) -> None:
        """String input returns a list, not a tuple or other sequence."""
        result = _normalise_namespace("facts")

        assert isinstance(result, list)

    def test_list_input_returns_list_type(self) -> None:
        """List input returns a list."""
        result = _normalise_namespace(["facts"])

        assert isinstance(result, list)

    def test_returns_new_list_not_same_reference(self) -> None:
        """The returned list should be a copy, not the same object.

        This prevents callers from accidentally mutating the input.
        """
        original = ["preferences", "user"]
        result = _normalise_namespace(original)

        assert result == original
        assert result is not original

    def test_tuple_input_converted_to_list(self) -> None:
        """A tuple input is converted to a list via list() call.

        The LangGraph SDK sometimes uses tuples for namespace segments.
        """
        result = _normalise_namespace(("org", "team", "agent"))  # type: ignore[arg-type]

        assert result == ["org", "team", "agent"]
        assert isinstance(result, list)


class TestNormaliseNamespaceConsistency:
    """Test that string and list inputs for the same namespace produce identical output.

    This is the core property that fixes the GET/DELETE 404 bug: a query param
    string 'preferences' must normalise to the same value as a JSON body
    list ['preferences'].
    """

    @pytest.mark.parametrize(
        ("string_input", "list_input"),
        [
            ("preferences", ["preferences"]),
            ("context", ["context"]),
            ("facts", ["facts"]),
            ("tokens", ["tokens"]),
        ],
        ids=["preferences", "context", "facts", "tokens"],
    )
    def test_string_and_list_produce_same_output(
        self,
        string_input: str,
        list_input: list[str],
    ) -> None:
        """String and list forms of the same namespace normalise identically."""
        from_string = _normalise_namespace(string_input)
        from_list = _normalise_namespace(list_input)

        assert from_string == from_list

    def test_real_world_namespace_preferences(self) -> None:
        """Reproduce the exact bug scenario from the bug report.

        PUT sends ["preferences"] (from JSON body).
        GET sends "preferences" (from query param).
        Both must normalise to ["preferences"].
        """
        put_namespace = _normalise_namespace(["preferences"])
        get_namespace = _normalise_namespace("preferences")

        assert put_namespace == get_namespace == ["preferences"]

    def test_real_world_multi_segment_namespace(self) -> None:
        """Multi-segment namespaces: the list form is canonical.

        Query params can only carry a single string, so multi-segment
        namespaces from query params would be dot-joined or similar.
        This test verifies the list form is stable.
        """
        namespace_segments = ["org", "user", "agent", "tokens"]
        result = _normalise_namespace(namespace_segments)

        assert result == ["org", "user", "agent", "tokens"]
