# Specializing The Base Repository

This repository is meant to be cloned, not edited in place for every domain. A specialization should keep the deploy/runtime shape and add project logic incrementally.

## Clone Checklist

1. Clone this repo into a new project repository.
2. Rename images, container names, `PROJECT_ID`, `WATCHTOWER_SCOPE`, and NAS path.
3. Set a dedicated Neo4j volume for the project.
4. Edit `mcp-server/instructions.md` with the AI-facing workflow.
5. Extend `mcp-server/src/graph/ontology.ts` only when a relation kind is truly reusable for the project.
6. Keep frontend calls routed through `server`, never directly to `mcp-server`.
7. Add NAS/data APIs under `server/src/routes/` and `server/src/storage/`.
8. Add AI-facing tools under `mcp-server/src/tools/` and register them from `mcp-server/src/index.ts`.
9. Keep generic `kg_*` tools available unless there is a clear safety reason to hide one.
10. Run CI and the MCP smoke test before deploying through Portainer.

## Suggested Specializations

### Fantasy Trilogy

Add ontology and tools for books, chapters, scenes, timeline events, factions, characters, locations, magic systems, open plot threads, foreshadowing, and continuity checks.

### Single Novel

Keep the same narrative primitives, but scope `PROJECT_ID`, document ingestion, and audits to one book. Ingest the world bible first, then draft chapters and revision notes.

### Jira/Confluence Knowledge Base

Add connectors/importers for Confluence pages, Jira tickets, components, incidents, runbooks, decisions, owners, procedures, and recurring problems. Keep provenance rich enough to trace every answer back to page keys, ticket keys, dates, and source URLs.

## What Should Stay Generic

- MCP transport and diagnostics.
- Neo4j connection and schema bootstrap in `mcp-server`.
- Backend read-only graph APIs for the frontend.
- Backend NAS persistence APIs.
- `kg_*` node/edge/retrieval primitives.
- Document chunk ingestion.
- Docker/Portainer/GHCR rollout pattern.

## What Belongs In A Clone

- Domain-specific prompt instructions.
- Domain-specific relation vocabulary.
- Domain-specific ingestion/parsing logic.
- External API connectors.
- Project-specific audit rules.
- Project-specific dashboards or frontends.
