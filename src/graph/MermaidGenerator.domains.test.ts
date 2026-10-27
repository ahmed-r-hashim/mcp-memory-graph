import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MemoryGraph } from './MemoryGraph.js';
import { MermaidGenerator } from './MermaidGenerator.js';
import { GraphEdge, MemoryNode } from '../types/graph.js';

describe('MermaidGenerator (domains and formatting)', () => {
  describe('with a MemoryGraph', () => {
    let dir: string;
    let graph: MemoryGraph;

    const generator = () => new MermaidGenerator((graph as any).nodes, (graph as any).edges, graph);

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mermaid-'));
      graph = new MemoryGraph({ storageDir: dir });
      await graph.initialize();
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await fs.rm(dir, { recursive: true, force: true });
    });

    async function seedCrossDomain(opts: { description?: string; refNodeId?: string; domainId?: string } = {}) {
      const domainId = opts.domainId ?? 'my-work';
      await graph.createDomain(domainId, 'Work', 'w');
      await graph.selectDomain(domainId);
      const w1 = await graph.storeMemory({ content: 'work one' });
      const w2 = await graph.storeMemory({
        content: 'work two',
        relationships: { relates_to: [{ targetId: w1.id, strength: 0.5 }] },
      });
      await graph.selectDomain('general');
      const g1 = await graph.storeMemory({
        content: 'general one',
        domainRefs: [{ domain: domainId, nodeId: opts.refNodeId ?? w1.id, description: opts.description }],
      });
      return { g1, w1, w2, domainId };
    }

    it('renders cross-domain references with dashed links and per-domain styles', async () => {
      const { g1, w1, w2 } = await seedCrossDomain({ description: 'see "work"' });

      const result = await generator().generateGraph({ startNodeId: g1.id, maxDepth: 3 });

      expect(result).toContain('classDef general');
      expect(result).toContain('classDef my_work');
      expect(result).toContain(`${g1.id} -.->|see \\"work\\"| ${w1.id}`);
      expect(result).toContain(`${g1.id}["general one"]`);
      expect(result).toContain(`${w1.id}["work one"]`);
      expect(result).toContain(`${w2.id} -->|relates_to| ${w1.id}`);
      expect(result).toMatch(new RegExp(`class ${g1.id} general`));
      expect(result).toMatch(new RegExp(`class [^\\n]*${w1.id}[^\\n]* my_work`));
      expect(graph.getCurrentDomain()).toBe('general');
    });

    it('labels undescribed references with a default', async () => {
      const { g1, w1 } = await seedCrossDomain();
      const result = await generator().generateGraph({ startNodeId: g1.id });
      expect(result).toContain(`${g1.id} -.->|domain-ref| ${w1.id}`);
    });

    it('does not follow domain references when disabled', async () => {
      const { g1 } = await seedCrossDomain();
      const result = await generator().generateGraph({ startNodeId: g1.id, followDomainPointers: false });
      expect(result).not.toContain('-.->');
      expect(result).not.toContain('classDef my_work');
    });

    it('records but does not traverse references to missing nodes', async () => {
      const { g1 } = await seedCrossDomain({ refNodeId: 'ghost' });
      const result = await generator().generateGraph({ startNodeId: g1.id });
      expect(result).toContain(`${g1.id} -.->|domain-ref| ghost`);
      expect(result).not.toContain('work one');
    });

    it('does not revisit already visited nodes across domains', async () => {
      const { g1, w1 } = await seedCrossDomain();
      // Edge in 'general' pointing back to the referenced work node id (visited via domain ref first)
      const g2 = await graph.storeMemory({
        content: 'general two',
        relationships: { relates_to: [{ targetId: g1.id, strength: 0.5 }] },
        domainRefs: [{ domain: 'my-work', nodeId: w1.id }],
      });
      const result = await generator().generateGraph({ startNodeId: g2.id, maxDepth: 4 });
      expect(result.match(new RegExp(`${w1.id}\\["work one"\\]`, 'g'))).toHaveLength(1);
    });

    it('handles cycles without duplicating edges', async () => {
      const a = await graph.storeMemory({ content: 'a' });
      const b = await graph.storeMemory({ content: 'b', relationships: { relates_to: [{ targetId: a.id, strength: 0.5 }] } });
      const c = await graph.storeMemory({
        content: 'c',
        relationships: { relates_to: [{ targetId: b.id, strength: 0.5 }], supports: [{ targetId: a.id, strength: 0.5 }] },
      });
      const result = await generator().generateGraph({ startNodeId: a.id, maxDepth: 4 });
      expect(result.match(/-->\|relates_to\|/g)).toHaveLength(2);
      expect(result.match(/-->\|supports\|/g)).toHaveLength(1);
      expect(result).toContain(`${c.id}["c"]`);
    });

    it('prefers titles and appends summaries', async () => {
      const node = await graph.storeMemory({ content: 'Long body text', title: 'Short Title', summary: 'A summary' });
      const result = await generator().generateGraph({ startNodeId: node.id });
      expect(result).toContain(`${node.id}["Short Title \nSummary: A summary"]`);
    });
  });

  describe('with a minimal memoryGraph stand-in', () => {
    it('falls back gracefully when the graph lacks domain helpers', async () => {
      const nodes = new Map<string, MemoryNode>([
        ['a', { id: 'a', content: 'first', timestamp: '2024-01-01T00:00:00Z', domainRefs: [{ domain: 'x', nodeId: 'b' }] }],
        ['b', { id: 'b', content: 'second', timestamp: '2024-01-02T00:00:00Z' }],
      ]);
      const edges: GraphEdge[] = [{ source: 'a', target: 'b', type: 'links', strength: 1, timestamp: 't' }];

      const result = await new MermaidGenerator(nodes, edges, {}).generateGraph({ startNodeId: 'a' });

      expect(result).toContain('a["first"]');
      expect(result).toContain('b["second"]');
      expect(result).toContain('a -.->|domain-ref| b');
    });
  });

  describe('timestamps', () => {
    it('formats content and summary timestamps for nodes reached through a MemoryGraph', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mermaid-ts-'));
      try {
        const graph = new MemoryGraph({ storageDir: dir });
        await graph.initialize();
        const node = await graph.storeMemory({ content: 'body', summary: 'sum' });
        await new Promise(resolve => setTimeout(resolve, 5));
        await graph.editMemory({ id: node.id, summary: 'newer sum' });

        const result = await new MermaidGenerator((graph as any).nodes, (graph as any).edges, graph).generateGraph({
          startNodeId: node.id,
          contentFormat: { includeTimestamp: true, includeId: true },
        });
        expect(result).toMatch(/\[[^\]]+\] body \n?Summary: newer sum \(\d+\/\d+\/\d+ \d+:\d{2}:\d{2} (AM|PM)\) \(Summary: \d+\/\d+\/\d+ \d+:\d{2}:\d{2} (AM|PM)\)/);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });
});
