import { runQuery as runQueryRaw, type GraphNode } from '../graph/neo4jStore.js';
import crypto from 'node:crypto';

export interface ConsolidationReport {
  ok: boolean;
  dryRun: boolean;
  mergedNodes: {
    target: { id: string; type: string; label: string };
    merged: { id: string; type: string; label: string };
  }[];
  inferredEdges: {
    from: { id: string; type: string; label: string };
    to: { id: string; type: string; label: string };
    kind: string;
    reason: string;
  }[];
  stats: {
    nodesBefore: number;
    nodesAfter: number;
    edgesBefore: number;
    edgesAfter: number;
  };
}

function normalizeLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Rimuove gli accenti
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Rimuove la punteggiatura
    .replace(/\s+/g, ' ') // Collassa spazi multipli
    .trim();
}

// Helper per unire metadati
function mergeMetadata(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const merged = { ...target };
  for (const key of Object.keys(source)) {
    if (merged[key] === undefined) {
      merged[key] = source[key];
    } else if (Array.isArray(merged[key]) && Array.isArray(source[key])) {
      merged[key] = [...new Set([...merged[key], ...source[key]])];
    } else if (typeof merged[key] === 'object' && typeof source[key] === 'object' && merged[key] !== null && source[key] !== null) {
      merged[key] = mergeMetadata(merged[key], source[key]);
    }
  }
  return merged;
}

export async function runConsolidation(dryRun = true, runQuery = runQueryRaw): Promise<ConsolidationReport> {
  // 1. Recupero statistiche iniziali
  const initialNodesRes = await runQuery('MATCH (n:Entity) RETURN count(n) as count', {});
  const initialEdgesRes = await runQuery('MATCH ()-[r]->() RETURN count(r) as count', {});
  const nodesBefore = (initialNodesRes[0]?.get('count') as number | undefined) ?? 0;
  const edgesBefore = (initialEdgesRes[0]?.get('count') as number | undefined) ?? 0;

  // 2. Recupero di tutti i nodi
  const allNodesRes = await runQuery(
    'MATCH (n:Entity) RETURN n.id as id, n.type as type, n.label as label, n.content as content, n.metadata as metadata, n.provenance as provenance, n.createdAt as createdAt',
    {}
  );
  
  const nodes: (GraphNode & { createdAt: string })[] = allNodesRes.map((r) => ({
    id: r.get('id') as string,
    type: r.get('type') as string,
    label: r.get('label') as string,
    content: r.get('content') as string,
    metadata: JSON.parse(r.get('metadata') as string || '{}'),
    provenance: JSON.parse(r.get('provenance') as string || '{}'),
    createdAt: r.get('createdAt') as string,
    updatedAt: r.get('createdAt') as string,
  }));

  const mergedNodes: { target: any; merged: any }[] = [];
  const inferredEdges: any[] = [];

  // Identificazione dei nodi da fondere
  const mergePlans: { target: GraphNode; duplicate: GraphNode }[] = [];

  // Pass 1: Duplicati espliciti (guidati da duplicateOf / mergedInto nei metadati)
  for (const node of nodes) {
    const duplicateOf = node.metadata.duplicateOf || node.metadata.mergedInto;
    if (duplicateOf) {
      const target = nodes.find((n) => n.id === duplicateOf);
      if (target && target.id !== node.id) {
        mergePlans.push({ target, duplicate: node });
        mergedNodes.push({
          target: { id: target.id, type: target.type, label: target.label },
          merged: { id: node.id, type: node.type, label: node.label },
        });
      }
    }
  }

  // Pass 2: Duplicati impliciti (basati su tipo e label normalizzata)
  const alreadyMergedIds = new Set(mergePlans.map((p) => p.duplicate.id));
  const groups = new Map<string, typeof nodes>();
  
  for (const node of nodes) {
    if (alreadyMergedIds.has(node.id)) continue;
    const norm = `${node.type}:${normalizeLabel(node.label)}`;
    if (!groups.has(norm)) {
      groups.set(norm, []);
    }
    groups.get(norm)!.push(node);
  }

  for (const group of groups.values()) {
    if (group.length > 1) {
      // Ordina per data di creazione (il più vecchio diventa il target)
      group.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const target = group[0];
      for (let i = 1; i < group.length; i++) {
        const duplicate = group[i];
        if (duplicate.id !== target.id) {
          mergePlans.push({ target, duplicate });
          mergedNodes.push({
            target: { id: target.id, type: target.type, label: target.label },
            merged: { id: duplicate.id, type: duplicate.type, label: duplicate.label },
          });
        }
      }
    }
  }

  // Esecuzione fusioni se dryRun = false
  if (!dryRun && mergePlans.length > 0) {
    for (const { target, duplicate } of mergePlans) {
      // Unione contenuti e metadati
      const newContent = target.content || duplicate.content;
      const newMetadata = mergeMetadata(target.metadata, duplicate.metadata);
      const newProvenance = mergeMetadata(target.provenance, duplicate.provenance);

      // Aggiornamento target nel database
      await runQuery(
        `MATCH (t:Entity {id: $targetId}) 
         SET t.content = $content, t.metadata = $metadata, t.provenance = $provenance, t.updatedAt = $updatedAt`,
        {
          targetId: target.id,
          content: newContent,
          metadata: JSON.stringify(newMetadata),
          provenance: JSON.stringify(newProvenance),
          updatedAt: new Date().toISOString(),
        }
      );

      // Spostamento relazioni uscenti
      await runQuery(
        `MATCH (d:Entity {id: $duplicateId})-[r]->(o:Entity)
         MATCH (t:Entity {id: $targetId})
         MERGE (t)-[newR:Relationship {kind: type(r)}]->(o)
         ON CREATE SET newR.id = apoc.create.uuid(), newR.weight = r.weight, newR.metadata = r.metadata, newR.provenance = r.provenance, newR.createdAt = r.createdAt
         DETACH DELETE r`,
        { duplicateId: duplicate.id, targetId: target.id }
      ).catch(async () => {
        // Fallback se APOC non è disponibile (creazione manuale via Cypher puro senza apoc.create.uuid)
        const rels = await runQuery(
          `MATCH (d:Entity {id: $duplicateId})-[r]->(o:Entity) 
           RETURN type(r) as kind, r.weight as weight, r.metadata as metadata, r.provenance as provenance, r.createdAt as createdAt, o.id as otherId`,
          { duplicateId: duplicate.id }
        );
        for (const rel of rels) {
          const kind = rel.get('kind') as string;
          await runQuery(
            `MATCH (t:Entity {id: $targetId}), (o:Entity {id: $otherId})
             MERGE (t)-[newR:Relationship {kind: $kind}]->(o)
             ON CREATE SET newR.id = $id, newR.weight = $weight, newR.metadata = $metadata, newR.provenance = $provenance, newR.createdAt = $createdAt`,
            {
              targetId: target.id,
              otherId: rel.get('otherId'),
              kind,
              id: crypto.randomUUID(),
              weight: rel.get('weight') ?? 1.0,
              metadata: rel.get('metadata') ?? '{}',
              provenance: rel.get('provenance') ?? '{}',
              createdAt: rel.get('createdAt') ?? new Date().toISOString(),
            }
          );
        }
      });

      // Spostamento relazioni entranti
      await runQuery(
        `MATCH (o:Entity)-[r]->(d:Entity {id: $duplicateId})
         MATCH (t:Entity {id: $targetId})
         MERGE (o)-[newR:Relationship {kind: type(r)}]->(t)
         ON CREATE SET newR.id = apoc.create.uuid(), newR.weight = r.weight, newR.metadata = r.metadata, newR.provenance = r.provenance, newR.createdAt = r.createdAt
         DETACH DELETE r`,
        { duplicateId: duplicate.id, targetId: target.id }
      ).catch(async () => {
        const rels = await runQuery(
          `MATCH (o:Entity)-[r]->(d:Entity {id: $duplicateId}) 
           RETURN type(r) as kind, r.weight as weight, r.metadata as metadata, r.provenance as provenance, r.createdAt as createdAt, o.id as otherId`,
          { duplicateId: duplicate.id }
        );
        for (const rel of rels) {
          const kind = rel.get('kind') as string;
          await runQuery(
            `MATCH (t:Entity {id: $targetId}), (o:Entity {id: $otherId})
             MERGE (o)-[newR:Relationship {kind: $kind}]->(t)
             ON CREATE SET newR.id = $id, newR.weight = $weight, newR.metadata = $metadata, newR.provenance = $provenance, newR.createdAt = $createdAt`,
            {
              targetId: target.id,
              otherId: rel.get('otherId'),
              kind,
              id: crypto.randomUUID(),
              weight: rel.get('weight') ?? 1.0,
              metadata: rel.get('metadata') ?? '{}',
              provenance: rel.get('provenance') ?? '{}',
              createdAt: rel.get('createdAt') ?? new Date().toISOString(),
            }
          );
        }
      });

      // Rimozione del nodo duplicato
      await runQuery('MATCH (d:Entity {id: $duplicateId}) DETACH DELETE d', { duplicateId: duplicate.id });
    }
  }

  // 3. Regole di Inferenza Relazionale (eseguite in sola lettura o scrittura a seconda di dryRun)
  // Regola 1: Se un personaggio ha uno stato cognitivo (knowledge_state, secret) o un obiettivo (character_goal) 
  // che parla di una fazione (faction) tramite "derived_from" o "mentions", inferiamo che il personaggio appartiene 
  // o è alleato di quella fazione.
  const inf1Res = await runQuery(
    `MATCH (c:Entity {type: 'character'})-[r1]-(state:Entity)-[r2]-(f:Entity {type: 'faction'})
     WHERE NOT (c)-[:member_of|ally_of]-(f)
     RETURN c.id as charId, c.label as charLabel, c.type as charType,
            f.id as facId, f.label as facLabel, f.type as facType,
            type(r1) as r1Kind, type(r2) as r2Kind`,
    {}
  );

  for (const record of inf1Res) {
    const from = { id: record.get('charId') as string, type: record.get('charType') as string, label: record.get('charLabel') as string };
    const to = { id: record.get('facId') as string, type: record.get('facType') as string, label: record.get('facLabel') as string };
    const kind = 'ally_of';
    const reason = `Associazione inferita tramite lo stato/obiettivo intermedio collegato alla fazione: ${record.get('charLabel')} -> ${record.get('facLabel')}`;
    
    inferredEdges.push({ from, to, kind, reason });

    if (!dryRun) {
      await runQuery(
        `MATCH (from:Entity {id: $fromId}), (to:Entity {id: $toId})
         MERGE (from)-[r:Relationship {kind: $kind}]->(to)
         ON CREATE SET r.id = $id, r.weight = 0.5, r.metadata = $metadata, r.provenance = $provenance, r.createdAt = $createdAt`,
        {
          fromId: from.id,
          toId: to.id,
          kind,
          id: crypto.randomUUID(),
          metadata: JSON.stringify({ inferred: true, rule: 'char_faction_intermediate' }),
          provenance: JSON.stringify({ source: 'consolidation_engine' }),
          createdAt: new Date().toISOString(),
        }
      );
    }
  }

  // Regola 2: Se un evento (timeline_event) è parte di un capitolo (chapter) e quel capitolo si svolge in una location,
  // inferiamo che l'evento si svolge in quella location.
  const inf2Res = await runQuery(
    `MATCH (e:Entity {type: 'timeline_event'})-[:part_of]->(ch:Entity {type: 'chapter'})-[:located_in]->(loc:Entity {type: 'location'})
     WHERE NOT (e)-[:located_in]-(loc)
     RETURN e.id as evId, e.label as evLabel, e.type as evType,
            loc.id as locId, loc.label as locLabel, loc.type as locType,
            ch.label as chLabel`,
    {}
  );

  for (const record of inf2Res) {
    const from = { id: record.get('evId') as string, type: record.get('evType') as string, label: record.get('evLabel') as string };
    const to = { id: record.get('locId') as string, type: record.get('locType') as string, label: record.get('locLabel') as string };
    const kind = 'located_in';
    const reason = `Evento timeline '${record.get('evLabel')}' inferito nella location '${record.get('locLabel')}' perché appartiene al capitolo '${record.get('chLabel')}' ambientato lì.`;

    inferredEdges.push({ from, to, kind, reason });

    if (!dryRun) {
      await runQuery(
        `MATCH (from:Entity {id: $fromId}), (to:Entity {id: $toId})
         MERGE (from)-[r:Relationship {kind: $kind}]->(to)
         ON CREATE SET r.id = $id, r.weight = 0.8, r.metadata = $metadata, r.provenance = $provenance, r.createdAt = $createdAt`,
        {
          fromId: from.id,
          toId: to.id,
          kind,
          id: crypto.randomUUID(),
          metadata: JSON.stringify({ inferred: true, rule: 'event_chapter_location' }),
          provenance: JSON.stringify({ source: 'consolidation_engine' }),
          createdAt: new Date().toISOString(),
        }
      );
    }
  }

  // Regola 3: Se un plot_thread menziona un personaggio, e quel personaggio ha un tema associato (theme),
  // inferiamo che il plot_thread tocca quel tema.
  const inf3Res = await runQuery(
    `MATCH (pt:Entity {type: 'plot_thread'})-[:mentions]->(c:Entity {type: 'character'})-[:has_theme]->(th:Entity {type: 'theme'})
     WHERE NOT (pt)-[:has_theme]-(th)
     RETURN pt.id as ptId, pt.label as ptLabel, pt.type as ptType,
            th.id as thId, th.label as thLabel, th.type as thType,
            c.label as charLabel`,
    {}
  );

  for (const record of inf3Res) {
    const from = { id: record.get('ptId') as string, type: record.get('ptType') as string, label: record.get('ptLabel') as string };
    const to = { id: record.get('thId') as string, type: record.get('thType') as string, label: record.get('thLabel') as string };
    const kind = 'has_theme';
    const reason = `Trama '${record.get('ptLabel')}' associata al tema '${record.get('thLabel')}' per associazione tematica del personaggio coivolto '${record.get('charLabel')}'.`;

    inferredEdges.push({ from, to, kind, reason });

    if (!dryRun) {
      await runQuery(
        `MATCH (from:Entity {id: $fromId}), (to:Entity {id: $toId})
         MERGE (from)-[r:Relationship {kind: $kind}]->(to)
         ON CREATE SET r.id = $id, r.weight = 0.5, r.metadata = $metadata, r.provenance = $provenance, r.createdAt = $createdAt`,
        {
          fromId: from.id,
          toId: to.id,
          kind,
          id: crypto.randomUUID(),
          metadata: JSON.stringify({ inferred: true, rule: 'plot_character_theme' }),
          provenance: JSON.stringify({ source: 'consolidation_engine' }),
          createdAt: new Date().toISOString(),
        }
      );
    }
  }

  // 4. Recupero statistiche finali
  const finalNodesRes = await runQuery('MATCH (n:Entity) RETURN count(n) as count', {});
  const finalEdgesRes = await runQuery('MATCH ()-[r]->() RETURN count(r) as count', {});
  const nodesAfter = (finalNodesRes[0]?.get('count') as number | undefined) ?? 0;
  const edgesAfter = (finalEdgesRes[0]?.get('count') as number | undefined) ?? 0;

  return {
    ok: true,
    dryRun,
    mergedNodes,
    inferredEdges,
    stats: {
      nodesBefore,
      nodesAfter,
      edgesBefore,
      edgesAfter,
    },
  };
}
