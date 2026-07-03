import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openQuestionLabel, registerCognitionTools, selfAssessmentLabel } from './cognition.js';

function registeredTools(server: McpServer): Record<string, { annotations?: Record<string, unknown> }> {
  return (server as unknown as { _registeredTools?: Record<string, { annotations?: Record<string, unknown> }> })._registeredTools ?? {};
}

test('cognition tools are registered with the correct safety annotations', () => {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerCognitionTools(server);
  const tools = registeredTools(server);

  const readOnly = ['kg_recent_changes', 'kg_list_open_questions', 'kg_get_latest_self_assessment'];
  for (const name of readOnly) {
    assert.ok(tools[name], `Missing tool ${name}`);
    assert.equal(tools[name].annotations?.readOnlyHint, true, `${name} must be read-only`);
    assert.equal(tools[name].annotations?.destructiveHint, false);
  }

  const writers = ['kg_log_open_question', 'kg_update_open_question', 'kg_log_self_assessment'];
  for (const name of writers) {
    assert.ok(tools[name], `Missing tool ${name}`);
    assert.equal(tools[name].annotations?.readOnlyHint, false, `${name} writes service nodes`);
    assert.equal(tools[name].annotations?.destructiveHint, false, `${name} must never be destructive`);
  }
});

test('openQuestionLabel is deterministic and normalizes whitespace/case', () => {
  const a = openQuestionLabel('Chi sa della piuma nel Capitolo 9?');
  const b = openQuestionLabel('  chi sa   della piuma nel capitolo 9?  ');
  assert.equal(a, b, 'same question re-logged must map to the same label (upsert, not duplicate)');
  assert.match(a, /^OQ-[0-9a-f]{12}$/);
  assert.notEqual(a, openQuestionLabel('Chi sa della piuma nel Capitolo 10?'));
});

test('selfAssessmentLabel is unique per run instant', () => {
  assert.equal(selfAssessmentLabel(' P1 ', '2026-07-03T20:00:00.000Z'), 'P1@2026-07-03T20:00:00.000Z');
  assert.notEqual(
    selfAssessmentLabel('P1', '2026-07-03T20:00:00.000Z'),
    selfAssessmentLabel('P1', '2026-07-03T21:00:00.000Z'),
  );
});
