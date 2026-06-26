import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import neo4j from 'neo4j-driver';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env.dev');
const SOURCE_ID = 'bibbia-gabriele-2025';
const TECHNICAL_TYPES = [
  'bible_section',
  'bible_outline',
  'bible_candidate',
  'bible_coverage_finding',
  'bible_mapping_batch',
];

function loadEnv() {
  const text = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^#=\s]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value).replace(/\r\n/g, '\n').trim()).digest('hex');
}

function stableKey(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function cleanText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function wordCount(text) {
  return cleanText(text).split(/\s+/).filter(Boolean).length;
}

function safeJson(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseBibleSections(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const headings = [];
  const headingRe = /^(\d+(?:\.\d+)*)\s+(.+?)\s*$/;

  for (let line = 0; line < lines.length; line++) {
    const match = lines[line].match(headingRe);
    if (!match) continue;
    headings.push({
      line,
      number: match[1],
      title: match[2].replace(/\s+/g, ' ').trim(),
      heading: `${match[1]} ${match[2].replace(/\s+/g, ' ').trim()}`,
    });
  }

  const headingByNumber = new Map(headings.map((heading) => [heading.number, heading.heading]));
  return headings.map((heading, index) => {
    const nextLine = headings[index + 1]?.line ?? lines.length;
    const text = cleanText(lines.slice(heading.line, nextLine).join('\n'));
    const parts = heading.number.split('.');
    const pathParts = parts.map((_, cursor) => parts.slice(0, cursor + 1).join('.'));
    const sectionPath = pathParts.map((number) => headingByNumber.get(number) ?? number);
    return {
      key: heading.number,
      heading: heading.title,
      order: index + 1,
      level: parts.length,
      path: sectionPath,
      content: text,
      contentHash: sha256(text),
      charCount: text.length,
      wordCount: wordCount(text),
    };
  });
}

function parentKeyFor(section, byKey, ordered) {
  const parts = section.key.split('.');
  for (let length = parts.length - 1; length > 0; length--) {
    const candidate = parts.slice(0, length).join('.');
    if (byKey.has(candidate)) return candidate;
  }
  for (let index = ordered.indexOf(section) - 1; index >= 0; index--) {
    if (ordered[index].level < section.level) return ordered[index].key;
  }
  return 'bible-root';
}

function sectionNode(section) {
  return {
    id: crypto.randomUUID(),
    type: 'bible_section',
    label: `${SOURCE_ID}::${section.key}`,
    content: section.content,
    metadata: {
      sourceId: SOURCE_ID,
      sourceType: 'novel_bible',
      sectionKey: section.key,
      sectionId: section.key,
      outlineNumber: section.key,
      heading: section.heading,
      order: section.order,
      level: section.level,
      path: section.path,
      contentHash: section.contentHash,
      charCount: section.charCount,
      wordCount: section.wordCount,
      canonStatus: 'canonical',
      replacementRun: true,
    },
    provenance: {
      source: 'replace_bible_corpus',
      sourceId: SOURCE_ID,
      sectionKey: section.key,
      contentHash: section.contentHash,
    },
  };
}

function rootNode(sectionCount, title) {
  return {
    id: crypto.randomUUID(),
    type: 'bible_outline',
    label: SOURCE_ID,
    content: title,
    metadata: {
      sourceId: SOURCE_ID,
      sourceType: 'novel_bible',
      title,
      sectionCount,
      canonStatus: 'canonical',
      ingestedAs: 'bible_sections',
      replacementRun: true,
    },
    provenance: { source: 'replace_bible_corpus', sourceId: SOURCE_ID },
  };
}

function edgeInput(fromId, toId, kind, metadata, provenance) {
  return {
    id: crypto.randomUUID(),
    fromId,
    toId,
    kind,
    weight: 1,
    metadata,
    provenance,
  };
}

function serializeNode(node) {
  return {
    id: node.properties.id,
    type: node.properties.type,
    label: node.properties.label,
    content: node.properties.content,
    metadata: safeJson(node.properties.metadata),
    provenance: safeJson(node.properties.provenance),
    createdAt: node.properties.createdAt,
    updatedAt: node.properties.updatedAt,
  };
}

function serializeRel(record) {
  const rel = record.get('r');
  return {
    id: rel.properties.id,
    kind: rel.properties.kind,
    fromId: record.get('fromId'),
    toId: record.get('toId'),
    weight: Number(rel.properties.weight ?? 1),
    metadata: safeJson(rel.properties.metadata),
    provenance: safeJson(rel.properties.provenance),
    createdAt: rel.properties.createdAt,
  };
}

async function main() {
  loadEnv();
  const biblePath = process.argv[2];
  if (!biblePath) throw new Error('Usage: node scripts/replace_bible_corpus.mjs <updated-bible-text-path>');

  const projectId = process.env.PROJECT_ID || 'romanzo-gabriele';
  const sections = parseBibleSections(biblePath);
  if (sections.length !== 866) throw new Error(`expected_866_sections: got ${sections.length}`);
  if (new Set(sections.map((section) => section.key)).size !== sections.length) throw new Error('duplicate_section_keys');
  for (const section of sections) {
    if (!section.content.trim()) throw new Error(`empty_section_content: ${section.key}`);
  }

  const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD));
  const session = driver.session();
  const backupDir = path.join(ROOT, 'dev-data', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${timestamp}-${SOURCE_ID}-technical-corpus-backup.json`);

  try {
    const nodesResult = await session.run(
      `
      MATCH (n:Entity {projectId: $projectId})
      WHERE n.type IN $types
        AND (
          n.label STARTS WITH $prefix
          OR n.metadata CONTAINS $sourceId
          OR n.provenance CONTAINS $sourceId
        )
      RETURN n
      ORDER BY n.type, n.label
      `,
      { projectId, types: TECHNICAL_TYPES, prefix: `${SOURCE_ID}::`, sourceId: SOURCE_ID },
    );
    const backupNodes = nodesResult.records.map((record) => serializeNode(record.get('n')));
    const nodeIds = backupNodes.map((node) => node.id);

    const relResult = await session.run(
      `
      MATCH (a:Entity {projectId: $projectId})-[r:REL]-(b:Entity {projectId: $projectId})
      WHERE a.id IN $nodeIds OR b.id IN $nodeIds
      RETURN DISTINCT r, a.id AS fromId, b.id AS toId
      ORDER BY r.kind, r.id
      `,
      { projectId, nodeIds },
    );
    const backupRelationships = relResult.records.map(serializeRel);
    const backup = {
      sourceId: SOURCE_ID,
      projectId,
      createdAt: new Date().toISOString(),
      biblePath,
      updatedSections: {
        count: sections.length,
        sha256: sha256(fs.readFileSync(biblePath, 'utf8')),
      },
      technicalTypes: TECHNICAL_TYPES,
      nodes: backupNodes,
      relationships: backupRelationships,
      counts: {
        nodes: backupNodes.length,
        relationships: backupRelationships.length,
        byType: backupNodes.reduce((acc, node) => {
          acc[node.type] = (acc[node.type] ?? 0) + 1;
          return acc;
        }, {}),
      },
    };
    fs.writeFileSync(backupPath, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');

    const verifiedBackup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    if (verifiedBackup.counts.nodes !== backupNodes.length) throw new Error('backup_node_count_mismatch');
    if (verifiedBackup.counts.relationships !== backupRelationships.length) throw new Error('backup_relationship_count_mismatch');

    const deleteResult = await session.executeWrite((tx) =>
      tx.run(
        `
        MATCH (n:Entity {projectId: $projectId})
        WHERE n.type IN $types
          AND (
            n.label STARTS WITH $prefix
            OR n.metadata CONTAINS $sourceId
            OR n.provenance CONTAINS $sourceId
          )
        WITH collect(n) AS nodes, count(n) AS deletedNodes
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN deletedNodes
        `,
        { projectId, types: TECHNICAL_TYPES, prefix: `${SOURCE_ID}::`, sourceId: SOURCE_ID },
      )
    );
    const deletedTechnicalNodes = deleteResult.records[0].get('deletedNodes').toNumber();

    const now = new Date().toISOString();
    const byKey = new Map(sections.map((section) => [section.key, section]));
    const root = rootNode(sections.length, 'Bibbia Gabriele - versione aggiornata consolidata');
    const sectionNodes = sections.map(sectionNode);
    const nodeByKey = new Map([['bible-root', root], ...sections.map((section, index) => [section.key, sectionNodes[index]])]);
    const edges = [];

    for (const section of sections) {
      const parentKey = parentKeyFor(section, byKey, sections);
      edges.push(edgeInput(
        nodeByKey.get(section.key).id,
        nodeByKey.get(parentKey).id,
        'part_of',
        { sourceId: SOURCE_ID, sectionKey: section.key, parentSectionKey: parentKey === 'bible-root' ? undefined : parentKey },
        { source: 'replace_bible_corpus', sourceId: SOURCE_ID, sectionKey: section.key },
      ));
    }
    for (let index = 0; index < sections.length - 1; index++) {
      edges.push(edgeInput(
        nodeByKey.get(sections[index].key).id,
        nodeByKey.get(sections[index + 1].key).id,
        'precedes',
        { sourceId: SOURCE_ID, orderScope: 'document', fromOrder: sections[index].order, toOrder: sections[index + 1].order },
        { source: 'replace_bible_corpus', sourceId: SOURCE_ID, sectionKey: sections[index].key },
      ));
    }

    await session.executeWrite(async (tx) => {
      const allNodes = [root, ...sectionNodes];
      await tx.run(
        `
        UNWIND $nodes AS row
        CREATE (n:Entity {
          id: row.id,
          projectId: $projectId,
          type: row.type,
          label: row.label,
          content: row.content,
          metadata: row.metadata,
          provenance: row.provenance,
          createdAt: $now,
          updatedAt: $now
        })
        `,
        {
          projectId,
          now,
          nodes: allNodes.map((node) => ({
            ...node,
            metadata: JSON.stringify(node.metadata),
            provenance: JSON.stringify(node.provenance),
          })),
        },
      );
      await tx.run(
        `
        UNWIND $edges AS row
        MATCH (a:Entity {projectId: $projectId, id: row.fromId})
        MATCH (b:Entity {projectId: $projectId, id: row.toId})
        CREATE (a)-[:REL {
          id: row.id,
          kind: row.kind,
          weight: row.weight,
          metadata: row.metadata,
          provenance: row.provenance,
          createdAt: $now
        }]->(b)
        `,
        {
          projectId,
          now,
          edges: edges.map((edge) => ({
            ...edge,
            metadata: JSON.stringify(edge.metadata),
            provenance: JSON.stringify(edge.provenance),
          })),
        },
      );
    });

    const postCounts = await session.run(
      `
      MATCH (n:Entity {projectId: $projectId})
      WHERE n.type IN $types AND (n.label STARTS WITH $prefix OR n.metadata CONTAINS $sourceId OR n.provenance CONTAINS $sourceId)
      RETURN n.type AS type, count(n) AS count
      ORDER BY n.type
      `,
      { projectId, types: TECHNICAL_TYPES, prefix: `${SOURCE_ID}::`, sourceId: SOURCE_ID },
    );
    const sectionCountResult = await session.run(
      `MATCH (n:Entity {projectId: $projectId, type: 'bible_section'}) WHERE n.label STARTS WITH $prefix RETURN count(n) AS count`,
      { projectId, prefix: `${SOURCE_ID}::` },
    );
    const physicalNonRel = await session.run(
      `MATCH (:Entity {projectId: $projectId})-[r]->(:Entity {projectId: $projectId}) WHERE type(r) <> 'REL' RETURN count(r) AS count`,
      { projectId },
    );

    const summary = {
      ok: true,
      backupPath,
      backupCounts: backup.counts,
      deletedTechnicalNodes,
      inserted: { nodes: sectionNodes.length + 1, sections: sectionNodes.length, edges: edges.length },
      postTechnicalCounts: postCounts.records.map((record) => ({ type: record.get('type'), count: record.get('count').toNumber() })),
      postSectionCount: sectionCountResult.records[0].get('count').toNumber(),
      nonRelPhysicalEdges: physicalNonRel.records[0].get('count').toNumber(),
    };
    if (summary.postSectionCount !== 866) throw new Error(`post_section_count_mismatch: ${summary.postSectionCount}`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
