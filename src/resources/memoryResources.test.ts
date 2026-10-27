import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MemoryGraph } from '../graph/MemoryGraph.js';
import { MemoryResources } from './memoryResources.js';
import { SqliteMemoryStorage } from '../storage/SqliteMemoryStorage.js';

describe('MemoryResources', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-resources-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function createSqliteResources() {
    const graph = new MemoryGraph({ storageDir: dir, storageType: 'sqlite' });
    await graph.initialize();
    const storage = (graph as any).storage as SqliteMemoryStorage;
    // The resource layer expects storage to expose its connection
    (storage as any).getDatabase = () => (storage as any).getConnection();
    return { graph, storage, resources: new MemoryResources(graph) };
  }

  describe('with SQLite storage', () => {
    let ctx: Awaited<ReturnType<typeof createSqliteResources>>;

    beforeEach(async () => {
      ctx = await createSqliteResources();
    });

    afterEach(async () => {
      await ctx.storage.close();
    });

    it('reports empty results on an empty graph', async () => {
      const stats = await ctx.resources.getDomainStatistics();
      expect(stats.domains).toHaveLength(1);
      expect(stats.domains[0].statistics.memoryCount).toBe(0);

      expect((await ctx.resources.getEdgeFilterTerms()).filterTerms).toEqual([]);
      expect(await ctx.resources.getPopularTags()).toEqual({
        popularTags: [],
        message: 'No tags available in the memory graph',
      });
      expect(await ctx.resources.getEssentialPriorityMemories()).toEqual({
        domains: [],
        message: 'No memories available in the memory graph',
      });
    });

    describe('with data', () => {
      beforeEach(async () => {
        const a = await ctx.graph.storeMemory({ content: 'Alpha memory', tags: ['x', 'y'] });
        const b = await ctx.graph.storeMemory({
          content: 'Beta memory',
          tags: ['x'],
          relationships: { relates_to: [{ targetId: a.id, strength: 0.8 }] },
        });
        await ctx.graph.storeMemory({
          content: 'Gamma memory',
          relationships: {
            synthesizes: [{ targetId: a.id, strength: 0.5 }, { targetId: b.id, strength: 0.5 }],
          },
        });
      });

      it('returns domain statistics', async () => {
        const stats = await ctx.resources.getDomainStatistics();
        expect(stats.domains[0]).toMatchObject({
          id: 'general',
          statistics: { memoryCount: 3 },
        });
      });

      it('returns edge filter terms ordered by frequency', async () => {
        const { filterTerms } = await ctx.resources.getEdgeFilterTerms();
        expect(filterTerms).toEqual([
          { type: 'synthesizes', frequency: 2 },
          { type: 'relates_to', frequency: 1 },
        ]);
      });

      it('returns popular tags', async () => {
        const { popularTags } = await ctx.resources.getPopularTags();
        expect(popularTags[0]).toEqual({ tag: 'x', frequency: 2 });
        expect(popularTags).toContainEqual({ tag: 'y', frequency: 1 });
      });

      it('returns essential memories grouped by domain with graph metrics', async () => {
        const { domains } = await ctx.resources.getEssentialPriorityMemories();
        expect(domains).toHaveLength(1);
        expect(domains[0]).toMatchObject({ id: 'general', name: 'General' });

        const memories = domains[0].essentialMemories;
        expect(memories).toHaveLength(3);
        const alpha = memories.find((m: any) => m.content === 'Alpha memory');
        expect(alpha.tags.sort()).toEqual(['x', 'y']);
        expect(alpha.graphMetrics.connectionCount).toBe(2);
        expect(alpha.graphMetrics.averageStrength).toBeCloseTo(0.65);

        const gamma = memories.find((m: any) => m.content === 'Gamma memory');
        expect(gamma.tags).toEqual([]);
      });

      it('reports zero average strength for unconnected memories', async () => {
        await ctx.graph.storeMemory({ content: 'Loner' });
        const { domains } = await ctx.resources.getEssentialPriorityMemories();
        const loner = domains[0].essentialMemories.find((m: any) => m.content === 'Loner');
        expect(loner.graphMetrics).toMatchObject({ connectionCount: 0, averageStrength: 0 });
      });

      it('reuses the cached database connection', async () => {
        const spy = jest.spyOn(ctx.storage as any, 'getDatabase');
        await ctx.resources.getDomainStatistics();
        await ctx.resources.getEdgeFilterTerms();
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('error handling', () => {
    it('fails every resource when storage is not SQLite', async () => {
      const graph = new MemoryGraph({ storageDir: dir, storageType: 'json' });
      await graph.initialize();
      const resources = new MemoryResources(graph);

      const expected = /SQLite storage is required/;
      await expect(resources.getDomainStatistics()).rejects.toThrow(expected);
      await expect(resources.getEdgeFilterTerms()).rejects.toThrow(expected);
      await expect(resources.getPopularTags()).rejects.toThrow(expected);
      await expect(resources.getEssentialPriorityMemories()).rejects.toThrow(expected);
    });

    it('fails when no database connection is returned', async () => {
      const { storage, resources } = await createSqliteResources();
      (storage as any).getDatabase = async () => null;
      await expect(resources.getDomainStatistics()).rejects.toThrow(/Failed to get database connection/);
      await storage.close();
    });

    it('wraps query failures', async () => {
      const { storage, resources } = await createSqliteResources();
      const failingDb = {
        all: jest.fn().mockRejectedValue(new Error('db down')),
        get: jest.fn().mockRejectedValue(new Error('db down')),
      };
      (storage as any).getDatabase = async () => failingDb;

      await expect(resources.getDomainStatistics()).rejects.toThrow(/Failed to get domain statistics.*db down/);
      await expect(resources.getEdgeFilterTerms()).rejects.toThrow(/Failed to get edge filter terms.*db down/);
      await expect(resources.getPopularTags()).rejects.toThrow(/Failed to get popular tags.*db down/);
      await expect(resources.getEssentialPriorityMemories()).rejects.toThrow(/Failed to get essential priority memories.*db down/);
      await storage.close();
    });
  });
});
