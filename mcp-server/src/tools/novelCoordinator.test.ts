import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNovelCoordinatorTools } from './novelCoordinator.js';

test('novel coordinator tools are registered correctly as read-only diagnostic tools', () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelCoordinatorTools(server);
  const tools = (server as unknown as { _registeredTools?: Record<string, { annotations?: Record<string, unknown> }> })._registeredTools ?? {};
  const expected = [
    'novel_verify_ingestion_threshold',
    'novel_get_coordination_prompt',
  ];

  for (const name of expected) {
    assert.ok(tools[name], `Missing tool ${name}`);
    assert.equal(tools[name].annotations?.readOnlyHint, true);
    assert.equal(tools[name].annotations?.destructiveHint, false);
  }
});
