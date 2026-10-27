import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { SqliteMemoryStorage } from './SqliteMemoryStorage.js';
import { DomainInfo, GraphEdge, MemoryNode } from '../types/graph.js';

const domain = (id: string): DomainInfo => ({
  id,
  name: id,
  description: `${id} domain`,
  created: '2024-01-01T00:00:00.000Z',
  lastAccess: '2024-01-01T00:00:00.000Z',
});

const ts = '2024-01-01T00:00:00.000Z';

describe('SqliteMemoryStorage (via DatabaseStorage)', () => {
  let dir: string;
  let storage: SqliteMemoryStorage;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-storage-'));
    storage = new SqliteMemoryStorage(dir);
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('initialize is idempotent', async () => {
    await expect(storage.initialize()).resolves.toBeUndefined();
  });

  it('close is safe to call repeatedly and the connection reopens on demand', async () => {
    await storage.close();
    await storage.close();
    expect((await storage.getDomains()).size).toBe(0);
  });

  describe('domains', () => {
    it('creates and lists domains', async () => {
      await storage.createDomain(domain('general'));
      const domains = await storage.getDomains();
      expect(domains.get('general')).toEqual(domain('general'));
    });

    it('saveDomains replaces all domains', async () => {
      await storage.createDomain(domain('old'));
      await storage.saveDomains(new Map([['a', domain('a')], ['b', domain('b')]]));
      expect([...(await storage.getDomains()).keys()].sort()).toEqual(['a', 'b']);
    });

    it('saveDomains rolls back and rethrows on failure', async () => {
      await storage.createDomain(domain('keep'));
      jest.spyOn(storage as any, 'executeUpdate').mockRejectedValueOnce(new Error('boom'));
      await expect(storage.saveDomains(new Map())).rejects.toThrow('boom');
      expect((await storage.getDomains()).has('keep')).toBe(true);
    });
  });

  describe('persistence state', () => {
    it('throws when state does not exist', async () => {
      await expect(storage.getPersistenceState()).rejects.toThrow('Persistence state not found');
    });

    it('inserts then updates state', async () => {
      await storage.createDomain(domain('general'));
      await storage.savePersistenceState({ currentDomain: 'general', lastAccess: ts });
      expect(await storage.getPersistenceState()).toMatchObject({ currentDomain: 'general', lastAccess: ts });

      await storage.savePersistenceState({ currentDomain: 'general', lastAccess: ts, lastMemoryId: 'm1' });
      expect((await storage.getPersistenceState()).lastMemoryId).toBe('m1');
    });
  });

  describe('memories', () => {
    const nodes = new Map<string, MemoryNode>([
      ['n1', {
        id: 'n1',
        content: 'Apple pie recipe',
        timestamp: ts,
        path: '/food',
        tags: ['cooking', 'dessert'],
        content_summary: 'pie',
        summary_timestamp: ts,
        domainRefs: [
          { domain: 'other', nodeId: 'x1', description: 'ref', bidirectional: true },
          { domain: 'other', nodeId: 'x2' },
        ],
      }],
      ['n2', { id: 'n2', content: 'Banana bread', timestamp: ts }],
    ]);
    const edges: GraphEdge[] = [
      { source: 'n1', target: 'n2', type: 'relates_to', strength: 0.7, timestamp: ts },
    ];

    beforeEach(async () => {
      await storage.createDomain(domain('general'));
      await storage.createDomain(domain('other'));
    });

    it('round-trips nodes, tags, domain refs and edges', async () => {
      await storage.saveMemories('general', nodes, edges);
      const loaded = await storage.getMemories('general');

      const n1 = loaded.nodes.get('n1')!;
      expect(n1.tags?.sort()).toEqual(['cooking', 'dessert']);
      expect(n1.domainRefs).toEqual(expect.arrayContaining([
        { domain: 'other', nodeId: 'x1', description: 'ref', bidirectional: true },
        { domain: 'other', nodeId: 'x2', description: null, bidirectional: false },
      ]));

      const n2 = loaded.nodes.get('n2')!;
      expect(n2.path).toBe('/');
      expect(n2.tags).toBeUndefined();
      expect(n2.domainRefs).toBeUndefined();

      expect(loaded.edges).toEqual(edges);
    });

    it('replaces existing data for the domain only', async () => {
      await storage.saveMemories('general', nodes, edges);
      await storage.saveMemories('other', new Map([['o1', { id: 'o1', content: 'other', timestamp: ts }]]), []);
      await storage.saveMemories('general', new Map([['n2', nodes.get('n2')!]]), []);

      expect([...(await storage.getMemories('general')).nodes.keys()]).toEqual(['n2']);
      expect([...(await storage.getMemories('other')).nodes.keys()]).toEqual(['o1']);
    });

    it('saveMemories rolls back and rethrows on failure', async () => {
      await storage.saveMemories('general', nodes, edges);
      jest.spyOn(storage as any, 'executeUpdate')
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('boom'));
      await expect(storage.saveMemories('general', new Map(), [])).rejects.toThrow('boom');
      expect((await storage.getMemories('general')).nodes.size).toBe(2);
    });
  });

  describe('searchContent', () => {
    beforeEach(async () => {
      await storage.createDomain(domain('general'));
      await storage.createDomain(domain('other'));
      await storage.saveMemories('general', new Map<string, MemoryNode>([
        ['n1', {
          id: 'n1',
          content: 'Apple pie recipe',
          timestamp: ts,
          tags: ['dessert'],
          domainRefs: [{ domain: 'other', nodeId: 'x', bidirectional: true }],
        }],
        ['n2', { id: 'n2', content: 'Banana bread', timestamp: ts }],
      ]), []);
      await storage.saveMemories('other', new Map([
        ['o1', { id: 'o1', content: 'Apple orchard', timestamp: ts }],
      ]), []);
    });

    it('finds matches across domains and hydrates tags and refs', async () => {
      const results = await storage.searchContent('apple');
      expect(results.map(r => r.id).sort()).toEqual(['n1', 'o1']);
      const n1 = results.find(r => r.id === 'n1')!;
      expect(n1.tags).toEqual(['dessert']);
      expect(n1.domainRefs).toEqual([{ domain: 'other', nodeId: 'x', description: null, bidirectional: true }]);
      expect(results.find(r => r.id === 'o1')!.tags).toBeUndefined();
    });

    it('restricts to a domain', async () => {
      const results = await storage.searchContent('apple', 'other');
      expect(results.map(r => r.id)).toEqual(['o1']);
    });

    it('honors maxResults', async () => {
      expect(await storage.searchContent('apple', undefined, 1)).toHaveLength(1);
    });

    it('returns an empty array when nothing matches', async () => {
      expect(await storage.searchContent('zebra')).toEqual([]);
    });
  });

  describe('dialect helpers', () => {
    it('maps booleans to 0/1', () => {
      const s = storage as any;
      expect(s.getBooleanValue(1)).toBe(true);
      expect(s.getBooleanValue(0)).toBe(false);
      expect(s.setBooleanValue(true)).toBe(1);
      expect(s.setBooleanValue(undefined)).toBe(0);
    });
  });
});
