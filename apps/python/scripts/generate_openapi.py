#!/usr/bin/env python3
"""Generate OpenAPI spec JSON from the server's Python spec definition.

Usage:
    python scripts/generate_openapi.py                  # writes to openapi-spec.json
    python scripts/generate_openapi.py -o docs/api.json # custom output path
    python scripts/generate_openapi.py --validate       # validate only, no write
    python scripts/generate_openapi.py --stats          # print spec statistics
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Ensure the src/ directory is on sys.path so we can import server
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))


def load_spec() -> dict:
    """Import and return the OpenAPI spec dict."""
    from server.openapi_spec import get_openapi_spec

    return get_openapi_spec()


def validate_refs(spec: dict) -> list[str]:
    """Check that all $ref pointers resolve to defined schemas.

    Returns:
        List of error messages (empty means valid).
    """
    spec_string = json.dumps(spec)
    referenced = set(re.findall(r"#/components/schemas/(\w+)", spec_string))
    defined = set(spec.get("components", {}).get("schemas", {}).keys())

    errors: list[str] = []
    missing = referenced - defined
    for schema_name in sorted(missing):
        errors.append(f"Referenced but not defined: #/components/schemas/{schema_name}")

    return errors


def collect_stats(spec: dict) -> dict:
    """Collect statistics about the spec."""
    paths = spec.get("paths", {})
    schemas = spec.get("components", {}).get("schemas", {})
    tags = spec.get("tags", [])

    # Count operations per HTTP method
    method_counts: dict[str, int] = {}
    operation_ids: list[str] = []
    for _path, methods in paths.items():
        for method, operation in methods.items():
            method_upper = method.upper()
            method_counts[method_upper] = method_counts.get(method_upper, 0) + 1
            operation_id = operation.get("operationId", "")
            if operation_id:
                operation_ids.append(operation_id)

    # Count operations per tag
    tag_counts: dict[str, int] = {}
    for _path, methods in paths.items():
        for _method, operation in methods.items():
            for tag in operation.get("tags", ["Untagged"]):
                tag_counts[tag] = tag_counts.get(tag, 0) + 1

    total_operations = sum(method_counts.values())

    return {
        "openapi_version": spec.get("openapi", "unknown"),
        "title": spec.get("info", {}).get("title", "unknown"),
        "api_version": spec.get("info", {}).get("version", "unknown"),
        "paths": len(paths),
        "total_operations": total_operations,
        "methods": method_counts,
        "schemas": len(schemas),
        "schema_names": sorted(schemas.keys()),
        "tags": len(tags),
        "tag_names": [tag["name"] for tag in tags],
        "operations_by_tag": tag_counts,
        "operation_ids": sorted(operation_ids),
    }


def print_stats(stats: dict) -> None:
    """Pretty-print spec statistics."""
    print(
        f"OpenAPI {stats['openapi_version']} — {stats['title']} v{stats['api_version']}"
    )
    print(f"{'=' * 60}")
    print(f"Paths:      {stats['paths']}")
    print(f"Operations: {stats['total_operations']}")
    print(f"Schemas:    {stats['schemas']}")
    print(f"Tags:       {stats['tags']}")
    print()

    print("Operations by HTTP method:")
    for method in ["GET", "POST", "PATCH", "PUT", "DELETE"]:
        count = stats["methods"].get(method, 0)
        if count:
            print(f"  {method:8s} {count}")
    print()

    print("Operations by tag:")
    for tag_name in stats["tag_names"]:
        count = stats["operations_by_tag"].get(tag_name, 0)
        print(f"  {tag_name:20s} {count}")
    untagged = stats["operations_by_tag"].get("Untagged", 0)
    if untagged:
        print(f"  {'Untagged':20s} {untagged}")
    print()

    print(f"Schemas ({stats['schemas']}):")
    for name in stats["schema_names"]:
        print(f"  {name}")
    print()

    print(f"Operation IDs ({len(stats['operation_ids'])}):")
    for operation_id in stats["operation_ids"]:
        print(f"  {operation_id}")


def main() -> int:
    """Entry point."""
    parser = argparse.ArgumentParser(
        description="Generate OpenAPI spec JSON for the OAP LangGraph Runtime.",
    )
    parser.add_argument(
        "-o",
        "--output",
        default="openapi-spec.json",
        help="Output file path (default: openapi-spec.json)",
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Validate the spec without writing a file.",
    )
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Print spec statistics.",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Write compact JSON (no indentation).",
    )
    arguments = parser.parse_args()

    spec = load_spec()

    # Always validate
    errors = validate_refs(spec)
    if errors:
        print("Validation FAILED:", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    if arguments.stats:
        stats = collect_stats(spec)
        print_stats(stats)
        return 0

    if arguments.validate:
        stats = collect_stats(spec)
        print(
            f"Valid OpenAPI {stats['openapi_version']} spec: "
            f"{stats['paths']} paths, {stats['total_operations']} operations, "
            f"{stats['schemas']} schemas"
        )
        return 0

    # Write the spec
    output_path = Path(arguments.output)
    indent = None if arguments.compact else 2
    spec_json = json.dumps(spec, indent=indent, ensure_ascii=False)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(spec_json + "\n", encoding="utf-8")

    size_bytes = output_path.stat().st_size
    stats = collect_stats(spec)
    print(
        f"Wrote {output_path} "
        f"({size_bytes:,} bytes, {stats['paths']} paths, "
        f"{stats['total_operations']} operations, {stats['schemas']} schemas)"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
