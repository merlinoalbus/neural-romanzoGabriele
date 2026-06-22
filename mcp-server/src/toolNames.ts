export const MCP_TOOL_NAMES = {
  ping: 'ping',
  get_server_status: 'get_server_status',
  list_mcp_capabilities: 'list_mcp_capabilities',
  kg_add_node: 'kg_add_node',
  kg_upsert_node: 'kg_upsert_node',
  kg_upsert_nodes: 'kg_upsert_nodes',
  kg_update_node: 'kg_update_node',
  kg_delete_node: 'kg_delete_node',
  kg_link: 'kg_link',
  kg_link_bulk: 'kg_link_bulk',
  kg_unlink: 'kg_unlink',
  kg_attach_asset: 'kg_attach_asset',
  kg_get_node: 'kg_get_node',
  kg_search: 'kg_search',
  kg_neighbors: 'kg_neighbors',
  kg_recall: 'kg_recall',
  kg_stats: 'kg_stats',
  kg_audit_global: 'kg_audit_global',
  kg_repair: 'kg_repair',
  kg_ingest_document: 'kg_ingest_document',
  kg_get_document_chunks: 'kg_get_document_chunks',
  kg_list_documents: 'kg_list_documents',
} as const;

export type McpToolName = typeof MCP_TOOL_NAMES[keyof typeof MCP_TOOL_NAMES];
export const ALL_MCP_TOOL_NAMES: readonly string[] = Object.values(MCP_TOOL_NAMES);
