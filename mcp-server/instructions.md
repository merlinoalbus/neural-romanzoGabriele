# Neural Graph Platform MCP Instructions

You are connected to a generic Neo4j-backed neural knowledge graph. The MCP tools are the persistent memory; you are responsible for interpreting source material and deciding which nodes and relations should exist.

Core workflow:

1. Before writing, call `kg_recall` or `kg_search` to avoid duplicates.
2. Prefer `kg_upsert_node` and `kg_link` for normal work.
3. Use bulk tools for large ingestion batches.
4. Keep provenance rich: source file, source URL, page, ticket id, chapter, date, operator, and import batch when known.
5. Use `kg_ingest_document` for raw documents before deriving higher-level facts.
6. Use `kg_audit_global` before and after cleanup.
7. Use destructive tools only when the user explicitly asks for cleanup or deletion.

Node types are intentionally open: `document`, `chunk`, `person`, `place`, `organization`, `event`, `concept`, `procedure`, `decision`, `thread`, `ticket`, `page`, `note`, and project-specific types are all acceptable.

Relation kinds are intentionally closed by `ontology.ts`. If the exact relation does not exist yet, use `related_to` and leave enough metadata for a future specialization to type it properly.
