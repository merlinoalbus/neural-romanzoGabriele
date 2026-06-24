import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as kg from '../graph/neo4jStore.js';
import { toolStructured, errorObj, toolError } from './responseHelpers.js';

export function registerSandboxTools(server: McpServer): void {
  server.registerTool(
    'novel_create_sandbox_brief',
    {
      title: 'Create Narrative Sandbox Brief',
      description: 'Generates a structured prompt brief for roleplaying/simulating a scene with specific character knowledge boundaries and psychological traits.',
      inputSchema: {
        characters: z.array(z.string()).min(1).describe('Names of characters in the scene.'),
        sceneObjective: z.string().describe('What happens in the scene / the scene goals.'),
      },
      outputSchema: {
        ok: z.boolean(),
        brief: z.string().optional(),
        error: errorObj,
      },
      annotations: { title: 'Create Narrative Sandbox Brief', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ characters, sceneObjective }) => {
      try {
        // 1. Recupero profili dei personaggi
        const charsRes = await kg.runQuery(
          'MATCH (c:Entity {type: "character"}) WHERE c.label IN $characters RETURN c.id as id, c.label as label, c.content as content',
          { characters }
        );
        const charProfiles = charsRes.map((r) => ({
          id: r.get('id') as string,
          label: r.get('label') as string,
          content: r.get('content') as string,
        }));

        if (!charProfiles.length) {
          return toolError('SANDBOX_NO_CHARACTERS_FOUND', 'Nessuno dei personaggi indicati è stato trovato nel catalogo del grafo.');
        }

        // 2. Recupero tratti dei personaggi
        const traitsRes = await kg.runQuery(
          `MATCH (t:Entity {type: "character_trait"})-[:applies_to|part_of|derived_from]-(c:Entity {type: "character"}) 
           WHERE c.label IN $characters 
           RETURN c.label as charLabel, t.label as label, t.content as content`,
          { characters }
        );
        const traits = traitsRes.map((r) => ({
          charLabel: r.get('charLabel') as string,
          label: r.get('label') as string,
          content: r.get('content') as string,
        }));

        // 3. Recupero stati di conoscenza e segreti
        const secretsRes = await kg.runQuery(
          `MATCH (s:Entity)-[r]-(c:Entity {type: "character"}) 
           WHERE c.label IN $characters AND s.type IN ["secret", "knowledge_state"] 
           RETURN c.label as charLabel, s.label as label, s.content as content, type(r) as relKind`,
          { characters }
        );
        const secrets = secretsRes.map((r) => ({
          charLabel: r.get('charLabel') as string,
          label: r.get('label') as string,
          content: r.get('content') as string,
          relKind: r.get('relKind') as string,
        }));

        // 4. Composizione del brief in Markdown
        let brief = `# NARRATIVE SANDBOX SIMULATION BRIEF\n\n`;
        brief += `**Scene Objective**: ${sceneObjective}\n\n`;
        brief += `--- \n\n`;
        brief += `## CHARACTER BOUNDARIES & PROFILES\n\n`;

        for (const char of charProfiles) {
          brief += `### Character: ${char.label}\n`;
          brief += `* **Profile**: ${char.content || 'N/A'}\n`;
          
          const charTraits = traits.filter((t) => t.charLabel === char.label);
          if (charTraits.length > 0) {
            brief += `* **Active Traits**:\n`;
            for (const t of charTraits) {
              brief += `  - **${t.label}**: ${t.content || 'No description'}\n`;
            }
          }

          const charKnowledge = secrets.filter((s) => s.charLabel === char.label && s.relKind !== 'does_not_know');
          if (charKnowledge.length > 0) {
            brief += `* **Knowledge Constraints (What they KNOW)**:\n`;
            for (const k of charKnowledge) {
              brief += `  - **${k.label}** (Rel: ${k.relKind}): ${k.content || 'No details'}\n`;
            }
          }

          const charOblivion = secrets.filter((s) => s.charLabel === char.label && s.relKind === 'does_not_know');
          if (charOblivion.length > 0) {
            brief += `* **Oblivion Constraints (What they DO NOT know)**:\n`;
            for (const o of charOblivion) {
              brief += `  - **${o.label}**: ${o.content || 'No details'}\n`;
            }
          }
          brief += `\n`;
        }

        brief += `--- \n\n`;
        brief += `## SIMULATION INSTRUCTIONS\n\n`;
        brief += `1. **Roleplay constraints**: Act and speak strictly as the characters specified above.\n`;
        brief += `2. **Strict Oblivion**: Under no circumstances can any character mention, imply, or act upon information listed in their **Oblivion Constraints**.\n`;
        brief += `3. **Strict Traits**: All dialogues and actions must adhere to their **Active Traits** and profiles.\n`;

        return toolStructured({ ok: true, brief });
      } catch (err) {
        return toolError('SANDBOX_BRIEF_FAILED', `novel_create_sandbox_brief failed: ${String(err)}`);
      }
    }
  );
}
