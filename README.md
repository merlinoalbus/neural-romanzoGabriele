# Neural Graph Platform - Base Template

Base repository for Neo4j-backed neural graph projects with the same deployment shape used by `manhua-app`: GitHub Actions, GHCR images, Portainer stack, NAS-mounted data, MCP tools, and a separated frontend.

## Architecture

The stack is intentionally split by responsibility:

- `frontend/`: React UI for the neural graph. The browser calls only the frontend origin.
- `server/`: internal backend for NAS persistence and read-only graph APIs used by the frontend.
- `mcp-server/`: MCP HTTP/SSE server used by the AI. It exposes `kg_*` tools and writes to Neo4j.
- `neo4j`: graph database, reachable only inside the Docker network.

The frontend does not call the MCP server. Nginx in the frontend container proxies `/api/v2/kg/*` to `neural_be`.

## Services

Portainer runs:

- `neural_fe`
- `neural_be`
- `neural_mcp`
- `neural_neo4j`
- `watchtower`

MCP can still be exposed separately for AI connectors through `MCP_HOST_PORT`, but it is not part of the browser path.

## Images

Pushes to `main` publish:

```text
ghcr.io/merlinoalbus/neural-graph-platform-backend:latest
ghcr.io/merlinoalbus/neural-graph-platform-frontend:latest
ghcr.io/merlinoalbus/neural-graph-platform-mcp:latest
```

Each image is also tagged with the commit SHA.

## Local Checks

```bash
npm ci --prefix server
npm run build --prefix server

npm ci --prefix mcp-server
npm run build --prefix mcp-server
npm run lint --prefix mcp-server
npm test --prefix mcp-server

npm ci --prefix frontend
npm run build --prefix frontend
```

## Docker Stack

```bash
cp .env.example .env
# edit NEO4J_PASSWORD, MCP_SHARED_SECRET, NAS_PROJECT_PATH, and host ports
docker compose up -d --build
```

The frontend is served from `FE_HOST_PORT`. The frontend proxies graph UI calls to `server`, and `server` reads Neo4j in read-only mode.

## Core MCP Tools

- Nodes: `kg_add_node`, `kg_upsert_node`, `kg_upsert_nodes`, `kg_update_node`, `kg_delete_node`
- Edges: `kg_link`, `kg_link_bulk`, `kg_unlink`
- Assets: `kg_attach_asset`
- Retrieval: `kg_get_node`, `kg_search`, `kg_neighbors`, `kg_recall`, `kg_stats`
- Maintenance: `kg_audit_global`, `kg_repair`
- Documents: `kg_ingest_document`, `kg_get_document_chunks`, `kg_list_documents`

`kg_ingest_document` writes graph nodes/chunks in Neo4j and asks `server` to save the source text under the NAS-mounted `/data/documents/...` path.
