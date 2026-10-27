import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MemoryGraph } from './MemoryGraph.js';
import { MariaDbMemoryStorage } from '../storage/MariaDbMemoryStorage.js';
import { JsonMemoryStorage } from '../storage/JsonMemoryStorage.js';

const sleep = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

describe('MemoryGraph (extended)', () => {
  let dir: string;
  let graph: MemoryGraph;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-graph-ext-'));
    graph = new MemoryGraph({ storageDir: dir });
    await graph.initialize();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('construction and initialization', () => {
    it('selects storage by configured type', () => {
      expect((new MemoryGraph({ storageDir: dir, storageType: 'MariaDB' }) as any).storage).toBeInstanceOf(MariaDbMemoryStorage);
      expect((new MemoryGraph({ storageDir: dir, storageType: 'unknown' }) as any).storage).toBeInstanceOf(JsonMemoryStorage);
    });

    it('honors defaultDomain', async () => {
      const g = new MemoryGraph({ storageDir: path.join(dir, 'x'), defaultDomain: 'custom' });
      expect(g.getCurrentDomain()).toBe('custom');
    });

    it('ignores a persisted domain that no longer exists', async () => {
      await fs.writeFile(
        path.join(dir, 'persistence.json'),
        JSON.stringify({ currentDomain: 'ghost', lastAccess: new Date().toISOString() })
      );
      const g = new MemoryGraph({ storageDir: dir });
      await g.initialize();
      expect(g.getCurrentDomain()).toBe('general');
    });
  });

  describe('storeMemory', () => {
    it('derives a title from the first sentence and truncates long ones', async () => {
      const short = await graph.storeMemory({ content: 'Short title. More text.' });
      expect(short.title).toBe('Short title');

      const long = await graph.storeMemory({ content: 'x'.repeat(60) });
      expect(long.title).toBe(`${'x'.repeat(40)}...`);
    });

    it('uses provided title, entities, summary and path', async () => {
      const node = await graph.storeMemory({
        content: 'c',
        title: 'T',
        keyEntities: ['E'],
        summary: 'S',
        path: '/p',
        domainRefs: [{ domain: 'x', nodeId: 'y' }],
      });
      expect(node).toMatchObject({ title: 'T', keyEntities: ['E'], content_summary: 'S', path: '/p' });
      expect(node.summary_timestamp).toBe(node.timestamp);
      expect(node.domainRefs).toEqual([{ domain: 'x', nodeId: 'y' }]);
    });

    it('falls back to the configured default path', async () => {
      const g = new MemoryGraph({ storageDir: path.join(dir, 'p'), defaultPath: '/default' });
      await g.initialize();
      expect((await g.storeMemory({ content: 'c' })).path).toBe('/default');
      expect((await graph.storeMemory({ content: 'c' })).path).toBe('/');
    });

    it('extracts capitalized words and quoted phrases as entities', async () => {
      const node = await graph.storeMemory({ content: 'Then Alice met Bob and "the red fox"' });
      expect(node.keyEntities).toEqual(expect.arrayContaining(['Alice', 'Bob', 'the red fox']));
    });

    it('limits extracted entities to 5', async () => {
      const node = await graph.storeMemory({ content: 'Then Alice met Bob and Carol with Dave plus Erin and Frank' });
      expect(node.keyEntities).toHaveLength(5);
    });

    it('creates edges only for existing targets', async () => {
      const target = await graph.storeMemory({ content: 'target' });
      await graph.storeMemory({
        content: 'source',
        relationships: { relates_to: [{ targetId: target.id, strength: 0.5 }, { targetId: 'missing', strength: 1 }] },
      });
      expect((graph as any).edges).toHaveLength(1);
    });

    describe('domain pointers', () => {
      beforeEach(async () => {
        await graph.createDomain('work', 'Work', 'Work stuff');
      });

      it('ignores pointers to unknown domains', async () => {
        const node = await graph.storeMemory({
          content: 'c',
          domainPointer: { domain: 'nope', bidirectional: false },
        });
        expect(node.domainRefs).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('Target domain does not exist: nope');
      });

      it('ignores pointers when the target domain has no entry point', async () => {
        const node = await graph.storeMemory({
          content: 'c',
          domainPointer: { domain: 'work', bidirectional: false },
        });
        expect(node.domainRefs).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('Could not find entry point in domain: work');
        expect(graph.getCurrentDomain()).toBe('general');
      });

      it('uses the most recent memory of the target domain as entry point', async () => {
        await graph.selectDomain('work');
        await graph.storeMemory({ content: 'older' });
        await sleep();
        const newest = await graph.storeMemory({ content: 'newest' });
        await graph.selectDomain('general');

        const node = await graph.storeMemory({
          content: 'c',
          domainPointer: { domain: 'work', bidirectional: false, description: 'see work' },
        });
        expect(node.domainRefs).toEqual([
          { domain: 'work', nodeId: newest.id, description: 'see work', bidirectional: false },
        ]);
        expect(graph.getCurrentDomain()).toBe('general');
      });

      it('appends to existing domainRefs', async () => {
        await graph.selectDomain('work');
        const w = await graph.storeMemory({ content: 'w' });
        await graph.selectDomain('general');

        const node = await graph.storeMemory({
          content: 'c',
          domainRefs: [{ domain: 'x', nodeId: 'y' }],
          domainPointer: { domain: 'work', entryPointId: w.id, bidirectional: false },
        });
        expect(node.domainRefs).toHaveLength(2);
      });

      describe('reverse references (createDomainReference)', () => {
        let w: any;
        const createRef = (sourceId: string, targetNodeId: string | undefined, description?: string) =>
          (graph as any).createDomainReference(sourceId, 'work', targetNodeId, true, description);

        beforeEach(async () => {
          await graph.selectDomain('work');
          w = await graph.storeMemory({ content: 'w' });
          await graph.selectDomain('general');
        });

        it('adds a reverse reference with a truncated or full description', async () => {
          const long = await graph.storeMemory({ content: 'L'.repeat(80) });
          const short = await graph.storeMemory({ content: 'short' });

          expect(await createRef(long.id, w.id, 'fwd')).toEqual({
            domain: 'work', nodeId: w.id, description: 'fwd', bidirectional: true,
          });
          await createRef(short.id, w.id);
          expect(graph.getCurrentDomain()).toBe('general');

          await graph.selectDomain('work');
          const refs = (graph as any).nodes.get(w.id).domainRefs;
          expect(refs).toHaveLength(2);
          expect(refs.find((r: any) => r.nodeId === long.id).description)
            .toBe(`Bidirectional reference to ${'L'.repeat(50)}...`);
          expect(refs.find((r: any) => r.nodeId === short.id).description)
            .toBe('Bidirectional reference to short');
        });

        it('uses the target domain entry point when none is given', async () => {
          const src = await graph.storeMemory({ content: 'src' });
          expect((await createRef(src.id, undefined)).nodeId).toBe(w.id);
        });

        it('does not duplicate an existing reverse reference', async () => {
          const src = await graph.storeMemory({ content: 'src' });
          await createRef(src.id, w.id);
          await createRef(src.id, w.id);

          await graph.selectDomain('work');
          expect((graph as any).nodes.get(w.id).domainRefs).toHaveLength(1);
        });

        it('skips the reverse reference if the target node does not exist', async () => {
          const src = await graph.storeMemory({ content: 'src' });
          await createRef(src.id, 'ghost');
          expect(graph.getCurrentDomain()).toBe('general');
        });

        it('does nothing extra when the source node is unknown', async () => {
          expect((await createRef('ghost', w.id)).nodeId).toBe(w.id);
        });

        it('logs and recovers if creating the reverse reference fails', async () => {
          const src = await graph.storeMemory({ content: 'src' });
          jest.spyOn(graph as any, 'save').mockRejectedValueOnce(new Error('disk full'));

          expect((await createRef(src.id, w.id)).nodeId).toBe(w.id);
          expect(errorSpy).toHaveBeenCalledWith('Error creating bidirectional reference:', expect.any(Error));
          expect(graph.getCurrentDomain()).toBe('general');
        });
      });

      it('returns no entry point when switching domains fails', async () => {
        jest.spyOn((graph as any).storage, 'getMemories').mockRejectedValueOnce(new Error('read failed'));
        const node = await graph.storeMemory({
          content: 'c',
          domainPointer: { domain: 'work', bidirectional: false },
        });
        expect(node.domainRefs).toBeUndefined();
        expect(errorSpy).toHaveBeenCalledWith('Error finding entry point in domain work:', expect.any(Error));
      });
    });
  });

  describe('searchContent', () => {
    it('delegates to storage and wraps the results', async () => {
      const a = await graph.storeMemory({ content: 'alpha one' });
      const b = await graph.storeMemory({
        content: 'beta',
        relationships: { relates_to: [{ targetId: a.id, strength: 0.5 }] },
      });

      const results = await graph.searchContent('alpha');
      expect(results).toHaveLength(1);
      expect(results[0].node.id).toBe(a.id);
      expect(results[0].edges).toHaveLength(1);
      expect(results[0].matchDetails).toEqual({ matches: ['alpha'], positions: [], relevance: 1 });
      expect(b.id).not.toBe(a.id);

      expect(await graph.searchContent('alpha', 'general', 1)).toHaveLength(1);
    });
  });

  describe('recallMemories', () => {
    let a: any, b: any, c: any;

    beforeEach(async () => {
      a = await graph.storeMemory({ content: 'Alpha apple', path: '/fruit', tags: ['red', 'sweet'] });
      await sleep();
      b = await graph.storeMemory({
        content: 'Beta banana',
        path: '/fruit',
        tags: ['yellow'],
        relationships: { relates_to: [{ targetId: a.id, strength: 0.9 }] },
      });
      await sleep();
      c = await graph.storeMemory({
        content: 'Gamma cherry',
        path: '/berry',
        tags: ['red'],
        relationships: {
          supports: [{ targetId: b.id, strength: 0.4 }],
          relates_to: [{ targetId: a.id, strength: 0.3 }],
        },
      });
    });

    it('filters by before/after', async () => {
      const before = await graph.recallMemories({ maxNodes: 10, strategy: 'recent', before: b.timestamp });
      expect(before.map(r => r.node.id)).toEqual([a.id]);
      const after = await graph.recallMemories({ maxNodes: 10, strategy: 'recent', after: b.timestamp });
      expect(after.map(r => r.node.id)).toEqual([c.id]);
    });

    it('limits results to maxNodes', async () => {
      expect(await graph.recallMemories({ maxNodes: 1, strategy: 'recent' })).toHaveLength(1);
    });

    it('returns nothing for an unknown strategy', async () => {
      expect(await graph.recallMemories({ maxNodes: 5, strategy: 'bogus' as any })).toEqual([]);
    });

    describe('related', () => {
      it('requires a start node', async () => {
        expect(await graph.recallMemories({ maxNodes: 5, strategy: 'related' })).toEqual([]);
      });

      it('ignores unknown start nodes', async () => {
        expect(await graph.recallMemories({ maxNodes: 5, strategy: 'related', startNodeId: 'ghost' })).toEqual([]);
      });

      it('walks the graph breadth-first with decaying scores', async () => {
        const results = await graph.recallMemories({ maxNodes: 10, strategy: 'related', startNodeId: c.id });
        expect(results.map(r => r.node.id)).toEqual([c.id, b.id, a.id]);
        expect(results[0].score).toBe(1);
        expect(results[1].score).toBe(0.5);
      });

      it('filters by relationship type and minimum strength', async () => {
        const byType = await graph.recallMemories({
          maxNodes: 10, strategy: 'related', startNodeId: c.id, relationshipTypes: ['supports'],
        });
        expect(byType.map(r => r.node.id)).toEqual([c.id, b.id]);

        const strong = await graph.recallMemories({
          maxNodes: 10, strategy: 'related', startNodeId: c.id, minStrength: 0.95,
        });
        expect(strong).toEqual([]);
      });

      it('stops at maxNodes', async () => {
        const results = await graph.recallMemories({ maxNodes: 1, strategy: 'related', startNodeId: c.id });
        expect(results).toHaveLength(1);
      });

      it('skips nodes without relevant edges', async () => {
        const lone = await graph.storeMemory({ content: 'lone' });
        expect(await graph.recallMemories({ maxNodes: 5, strategy: 'related', startNodeId: lone.id })).toEqual([]);
      });
    });

    describe('path and tag', () => {
      it('requires a path for the path strategy', async () => {
        expect(await graph.recallMemories({ maxNodes: 5, strategy: 'path' })).toEqual([]);
        const results = await graph.recallMemories({ maxNodes: 5, strategy: 'path', path: '/berry' });
        expect(results.map(r => r.node.id)).toEqual([c.id]);
      });

      it('requires tags for the tag strategy and matches all tags', async () => {
        expect(await graph.recallMemories({ maxNodes: 5, strategy: 'tag' })).toEqual([]);
        expect(await graph.recallMemories({ maxNodes: 5, strategy: 'tag', tags: [] })).toEqual([]);
        const results = await graph.recallMemories({ maxNodes: 5, strategy: 'tag', tags: ['red', 'sweet'] });
        expect(results.map(r => r.node.id)).toEqual([a.id]);
      });
    });

    describe('content', () => {
      it('returns nothing without keywords or regex', async () => {
        expect(await graph.recallMemories({ maxNodes: 5, strategy: 'content' })).toEqual([]);
        expect(await graph.recallMemories({ maxNodes: 5, strategy: 'content', search: { keywords: [] } })).toEqual([]);
      });

      it('matches keywords case-insensitively by default', async () => {
        const results = await graph.recallMemories({
          maxNodes: 5, strategy: 'content', search: { keywords: ['APPLE', 'a'] },
        });
        expect(results[0].node.id).toBe(a.id);
        expect(results[0].matchDetails?.matches).toContain('apple');
      });

      it('supports case-sensitive keyword search', async () => {
        expect(await graph.recallMemories({
          maxNodes: 5, strategy: 'content', search: { keywords: ['apple'], caseSensitive: true },
        })).toHaveLength(1);
        expect(await graph.recallMemories({
          maxNodes: 5, strategy: 'content', search: { keywords: ['APPLE'], caseSensitive: true },
        })).toEqual([]);
      });

      it('supports fuzzy matching', async () => {
        const results = await graph.recallMemories({
          maxNodes: 5, strategy: 'content', search: { keywords: ['bananna'], fuzzyMatch: true },
        });
        expect(results.map(r => r.node.id)).toContain(b.id);
      });

      it('supports regex search (case-insensitive and case-sensitive)', async () => {
        const insensitive = await graph.recallMemories({
          maxNodes: 5, strategy: 'content', search: { regex: 'gamma|beta' },
        });
        expect(insensitive.map(r => r.node.id).sort()).toEqual([b.id, c.id].sort());
        expect(insensitive[0].matchDetails?.positions).toEqual([0]);

        const sensitive = await graph.recallMemories({
          maxNodes: 5, strategy: 'content', search: { regex: 'gamma', caseSensitive: true },
        });
        expect(sensitive).toEqual([]);
      });
    });

    describe('combinedStrategy', () => {
      it('merges results from content, path, tag and related searches, keeping the best score', async () => {
        const results = await graph.recallMemories({
          maxNodes: 10,
          strategy: 'content',
          combinedStrategy: true,
          search: { keywords: ['alpha'] },
          path: '/berry',
          tags: ['yellow'],
          startNodeId: c.id,
        });
        const ids = results.map(r => r.node.id);
        expect(new Set(ids)).toEqual(new Set([a.id, b.id, c.id]));
        expect(ids).toHaveLength(3);
        // 'a' is found by content (score > 0 but tiny), related (0.5) -> best kept
        expect(results.find(r => r.node.id === a.id)!.score).toBeGreaterThanOrEqual(0.5);
      });

      it('returns nothing when no criteria are provided', async () => {
        expect(await graph.recallMemories({ maxNodes: 10, strategy: 'recent', combinedStrategy: true })).toEqual([]);
      });
    });

    describe('sortBy', () => {
      it('sorts by relevance', async () => {
        const results = await graph.recallMemories({
          maxNodes: 10, strategy: 'related', startNodeId: c.id, sortBy: 'relevance',
        });
        expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score);
      });

      it('sorts by date', async () => {
        const results = await graph.recallMemories({ maxNodes: 10, strategy: 'path', path: '/fruit', sortBy: 'date' });
        expect(results.map(r => r.node.id)).toEqual([b.id, a.id]);
      });

      it('sorts by strongest edge', async () => {
        const results = await graph.recallMemories({ maxNodes: 10, strategy: 'recent', sortBy: 'strength' });
        // a and b are connected via a 0.9 edge; c only has edges up to 0.4
        expect(results[results.length - 1].node.id).toBe(c.id);
      });
    });
  });

  describe('forgetMemory', () => {
    it('returns false for unknown ids without saving', async () => {
      expect(await graph.forgetMemory({ id: 'ghost' })).toBe(false);
    });

    it('removes the node and its edges', async () => {
      const a = await graph.storeMemory({ content: 'a' });
      const b = await graph.storeMemory({
        content: 'b',
        relationships: { relates_to: [{ targetId: a.id, strength: 0.5 }] },
      });
      expect(await graph.forgetMemory({ id: b.id })).toBe(true);
      expect((graph as any).edges).toEqual([]);
      expect((graph as any).nodes.has(a.id)).toBe(true);
    });

    it('cascades to directly connected nodes', async () => {
      const a = await graph.storeMemory({ content: 'a' });
      const b = await graph.storeMemory({
        content: 'b',
        relationships: { relates_to: [{ targetId: a.id, strength: 0.5 }] },
      });
      const c = await graph.storeMemory({
        content: 'c',
        relationships: { relates_to: [{ targetId: b.id, strength: 0.5 }] },
      });
      const lone = await graph.storeMemory({ content: 'lone' });

      expect(await graph.forgetMemory({ id: b.id, cascade: true })).toBe(true);
      const remaining = [...(graph as any).nodes.keys()];
      expect(remaining).toEqual([lone.id]);
      expect(remaining).not.toContain(a.id);
      expect(remaining).not.toContain(c.id);
      expect((graph as any).edges).toEqual([]);
    });
  });

  describe('editMemory', () => {
    it('throws for unknown ids', async () => {
      await expect(graph.editMemory({ id: 'ghost' })).rejects.toThrow('Memory not found: ghost');
    });

    it('updates content and nudges about an outdated summary', async () => {
      const node = await graph.storeMemory({ content: 'old', summary: 'sum' });
      const edited = await graph.editMemory({ id: node.id, content: 'new' });
      expect(edited.content).toBe('new');
      expect(edited.content_summary).toBe('sum');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Consider updating the summary'));
    });

    it('updates content and summary together without the nudge', async () => {
      const node = await graph.storeMemory({ content: 'old', summary: 'sum' });
      const edited = await graph.editMemory({ id: node.id, content: 'new', summary: 'new sum' });
      expect(edited.content_summary).toBe('new sum');
      expect(edited.summary_timestamp).toBeDefined();
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('does not nudge when there is no summary to update', async () => {
      const node = await graph.storeMemory({ content: 'old' });
      await graph.editMemory({ id: node.id, content: 'new' });
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('replaces outgoing relationships and ignores missing targets', async () => {
      const a = await graph.storeMemory({ content: 'a' });
      const b = await graph.storeMemory({ content: 'b' });
      const c = await graph.storeMemory({
        content: 'c',
        relationships: { relates_to: [{ targetId: a.id, strength: 0.5 }] },
      });

      await graph.editMemory({
        id: c.id,
        relationships: { supports: [{ targetId: b.id, strength: 0.7 }, { targetId: 'ghost', strength: 1 }] },
      });
      expect((graph as any).edges).toEqual([
        expect.objectContaining({ source: c.id, target: b.id, type: 'supports', strength: 0.7 }),
      ]);
    });

    describe('moving between domains', () => {
      beforeEach(async () => {
        await graph.createDomain('work', 'Work', 'Work stuff');
      });

      it('rejects unknown target domains', async () => {
        const node = await graph.storeMemory({ content: 'a' });
        await expect(graph.editMemory({ id: node.id, targetDomain: 'ghost' })).rejects.toThrow('Target domain not found: ghost');
      });

      it('is a no-op when the target is the current domain', async () => {
        const node = await graph.storeMemory({ content: 'a' });
        await graph.editMemory({ id: node.id, targetDomain: 'general' });
        expect(logSpy).toHaveBeenCalledWith(`Memory ${node.id} already in domain general`);
        expect((graph as any).nodes.has(node.id)).toBe(true);
      });

      it('moves the node and its edges to the target domain', async () => {
        const a = await graph.storeMemory({ content: 'a' });
        const b = await graph.storeMemory({
          content: 'b',
          relationships: { relates_to: [{ targetId: a.id, strength: 0.5 }] },
        });

        await graph.editMemory({ id: b.id, targetDomain: 'work' });

        expect(graph.getCurrentDomain()).toBe('general');
        expect((graph as any).nodes.has(b.id)).toBe(false);
        expect((graph as any).edges).toEqual([]);

        await graph.selectDomain('work');
        expect((graph as any).nodes.has(b.id)).toBe(true);
        expect((graph as any).edges).toHaveLength(1);
      });

      it('reports failures while moving', async () => {
        const node = await graph.storeMemory({ content: 'a' });
        jest.spyOn(graph as any, 'save').mockRejectedValueOnce(new Error('disk full'));
        await expect(graph.editMemory({ id: node.id, targetDomain: 'work' }))
          .rejects.toThrow('Failed to move memory to work');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error moving memory'));
      });
    });
  });

  describe('traverseMemories', () => {
    it('fails on an empty domain', async () => {
      await expect(graph.traverseMemories({})).rejects.toThrow('No memories found in current domain');
    });

    it('fails when the start node does not exist', async () => {
      await expect(graph.traverseMemories({ startNodeId: 'ghost' })).rejects.toThrow('Starting memory not found: ghost');
    });

    describe('within a domain', () => {
      let a: any, b: any, c: any;

      beforeEach(async () => {
        a = await graph.storeMemory({ content: 'a' });
        await sleep();
        b = await graph.storeMemory({
          content: 'b',
          relationships: { relates_to: [{ targetId: a.id, strength: 0.5 }] },
        });
        await sleep();
        c = await graph.storeMemory({
          content: 'c',
          relationships: { relates_to: [{ targetId: b.id, strength: 0.5 }] },
        });
      });

      it('starts from the most recent memory by default and walks to the default depth of 2', async () => {
        const result = await graph.traverseMemories({});
        expect(result.context).toEqual({ startingPoint: c.id, depth: 2, domains: ['general'] });
        expect(result.nodes.map(n => n.id)).toEqual([c.id, b.id, a.id]);
        expect(result.crossDomainConnections).toEqual([]);
      });

      it('respects maxDepth', async () => {
        const result = await graph.traverseMemories({ startNodeId: c.id, maxDepth: 1 });
        expect(result.nodes.map(n => n.id)).toEqual([c.id, b.id]);
      });

      it('respects maxNodesPerDomain', async () => {
        const result = await graph.traverseMemories({ startNodeId: c.id, maxNodesPerDomain: 1 });
        expect(result.nodes).toHaveLength(1);
      });

      it('returns nothing for a target domain different from the start', async () => {
        await graph.createDomain('work', 'Work', 'w');
        const result = await graph.traverseMemories({ startNodeId: c.id, targetDomain: 'work' });
        expect(result.nodes).toEqual([]);
      });
    });

    describe('across domains', () => {
      let g1: any, w1: any;

      beforeEach(async () => {
        await graph.createDomain('work', 'Work', 'w');
        await graph.selectDomain('work');
        w1 = await graph.storeMemory({ content: 'work node' });
        await graph.selectDomain('general');
        g1 = await graph.storeMemory({
          content: 'general node',
          domainRefs: [{ domain: 'work', nodeId: w1.id, description: 'to work' }],
        });
      });

      it('follows domain pointers by default and restores the original domain', async () => {
        const result = await graph.traverseMemories({ startNodeId: g1.id });
        expect(result.nodes.map(n => n.id)).toEqual([g1.id, w1.id]);
        expect(result.crossDomainConnections).toEqual([{
          fromDomain: 'general', fromNodeId: g1.id, toDomain: 'work', toNodeId: w1.id, description: 'to work',
        }]);
        expect(result.context.domains).toEqual(['general', 'work']);
        expect(graph.getCurrentDomain()).toBe('general');
      });

      it('can ignore domain pointers', async () => {
        const result = await graph.traverseMemories({ startNodeId: g1.id, followDomainPointers: false });
        expect(result.nodes.map(n => n.id)).toEqual([g1.id]);
        expect(result.crossDomainConnections).toEqual([]);
      });

      it('skips pointers to other domains when restricted to the current one', async () => {
        const result = await graph.traverseMemories({ startNodeId: g1.id, targetDomain: 'general' });
        expect(result.nodes.map(n => n.id)).toEqual([g1.id]);
        expect(result.crossDomainConnections).toEqual([]);
      });

      it('skips pointers to missing nodes but records the connection', async () => {
        const dangling = await graph.storeMemory({
          content: 'dangling',
          domainRefs: [{ domain: 'work', nodeId: 'ghost' }],
        });
        const result = await graph.traverseMemories({ startNodeId: dangling.id });
        expect(result.nodes.map(n => n.id)).toEqual([dangling.id]);
        expect(result.crossDomainConnections).toHaveLength(1);
      });
    });
  });
});
