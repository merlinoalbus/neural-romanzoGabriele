import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerNovelEditingTools } from './novelEditing.js';

test('novel editing workflow tools are registered as write-capable operational tools', () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerNovelEditingTools(server);
  const tools = (server as unknown as { _registeredTools?: Record<string, { annotations?: Record<string, unknown> }> })._registeredTools ?? {};
  const expected = [
    'novel_start_editing_session',
    'novel_split_chapter_blocks',
    'novel_save_editorial_findings',
    'novel_save_user_decisions',
    'novel_save_rewrite_block',
    'novel_assemble_chapter_revision',
    'novel_save_seam_review',
    'novel_save_final_chapter',
    'novel_create_visual_brief',
    'novel_attach_generated_image',
  ];

  for (const name of expected) {
    assert.ok(tools[name], `Missing tool ${name}`);
    assert.equal(tools[name].annotations?.readOnlyHint, false);
    assert.equal(tools[name].annotations?.destructiveHint, false);
  }
});
