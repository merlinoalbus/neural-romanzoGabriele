import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNovelRevisionImpactTools } from './novelRevisionImpact.js';

test('novel_scan_revision_impact is registered as a read-only tool', () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelRevisionImpactTools(server);
  const tools = (server as unknown as { _registeredTools?: Record<string, { annotations?: Record<string, unknown> }> })._registeredTools ?? {};

  const scan = tools['novel_scan_revision_impact'];
  assert.ok(scan, 'Missing tool novel_scan_revision_impact');
  assert.equal(scan.annotations?.readOnlyHint, true, 'must never rewrite anything — only report');
  assert.equal(scan.annotations?.destructiveHint, false);
});
