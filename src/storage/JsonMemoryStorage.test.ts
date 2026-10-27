import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { JsonMemoryStorage } from './JsonMemoryStorage.js';
import { DomainInfo, MemoryNode } from '../types/graph.js';

const domain = (id: string): DomainInfo => ({
  id,
  name: id,
  description: `${id} domain`,
  created: '2024-01-01T00:00:00.000Z',
  lastAccess: '2024-01-01T00:00:00.000Z',
});

const node = (id: string, content: string): MemoryNode => ({
  id,
  content,
  timestamp: '2024-01-01T00:00:00.000Z',
});

describe('JsonMemoryStorage', () => {
  let dir: string;
  let storage: JsonMemoryStorage;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-storage-'));
    storage = new JsonMemoryStorage(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('initialize creates storage and memories directories', async () => {
    await storage.initialize();
    const stat = await fs.stat(path.join(dir, 'memories'));
    expect(stat.isDirectory()).toBe(true);
  });

  describe('domains', () => {
    beforeEach(() => storage.initialize());

    it('returns an empty map when no domains file exists', async () => {
      expect((await storage.getDomains()).size).toBe(0);
    });

    it('rethrows non-ENOENT errors when reading domains', async () => {
      await fs.writeFile(path.join(dir, 'domains.json'), '{not json');
      await expect(storage.getDomains()).rejects.toThrow();
    });

    it('saves and reads domains', async () => {
      await storage.saveDomains(new Map([['a', domain('a')]]));
      const domains = await storage.getDomains();
      expect(domains.get('a')).toEqual(domain('a'));
    });

    it('createDomain registers the domain and creates an empty memory file', async () => {
      await storage.createDomain(domain('work'));
      expect((await storage.getDomains()).has('work')).toBe(true);
      const { nodes, edges } = await storage.getMemories('work');
      expect(nodes.size).toBe(0);
      expect(edges).toEqual([]);
    });
  });

  describe('persistence state', () => {
    beforeEach(() => storage.initialize());

    it('throws when the state file does not exist', async () => {
      await expect(storage.getPersistenceState()).rejects.toThrow('Persistence state not found');
    });

    it('rethrows non-ENOENT errors', async () => {
      await fs.writeFile(path.join(dir, 'persistence.json'), '{not json');
      await expect(storage.getPersistenceState()).rejects.toThrow();
    });

    it('round-trips state', async () => {
      const state = { currentDomain: 'general', lastAccess: '2024-01-01T00:00:00.000Z', lastMemoryId: 'x' };
      await storage.savePersistenceState(state);
      expect(await storage.getPersistenceState()).toEqual(state);
    });
  });

  describe('memories', () => {
    beforeEach(() => storage.initialize());

    it('returns empty data for a domain without a file', async () => {
      const { nodes, edges } = await storage.getMemories('missing');
      expect(nodes.size).toBe(0);
      expect(edges).toEqual([]);
    });

    it('rethrows non-ENOENT errors', async () => {
      await fs.writeFile(path.join(dir, 'memories', 'bad.json'), '{not json');
      await expect(storage.getMemories('bad')).rejects.toThrow();
    });

    it('tolerates files without nodes or edges', async () => {
      await fs.writeFile(path.join(dir, 'memories', 'empty.json'), '{}');
      const { nodes, edges } = await storage.getMemories('empty');
      expect(nodes.size).toBe(0);
      expect(edges).toEqual([]);
    });

    it('saves and reads nodes and edges', async () => {
      const edge = { source: 'a', target: 'b', type: 'relates_to', strength: 0.5, timestamp: 't' };
      await storage.saveMemories('general', new Map([['a', node('a', 'one')]]), [edge]);
      const { nodes, edges } = await storage.getMemories('general');
      expect(nodes.get('a')?.content).toBe('one');
      expect(edges).toEqual([edge]);
    });
  });

  describe('searchContent', () => {
    beforeEach(async () => {
      await storage.initialize();
      await storage.saveDomains(new Map([['a', domain('a')], ['b', domain('b')]]));
      await storage.saveMemories('a', new Map([
        ['1', node('1', 'Apple pie')],
        ['2', node('2', 'apple tart')],
        ['3', node('3', 'Banana')],
      ]), []);
      await storage.saveMemories('b', new Map([['4', node('4', 'APPLE sauce')]]), []);
    });

    it('searches all domains case-insensitively', async () => {
      const results = await storage.searchContent('apple');
      expect(results.map(r => r.id).sort()).toEqual(['1', '2', '4']);
    });

    it('restricts to a domain', async () => {
      const results = await storage.searchContent('apple', 'b');
      expect(results.map(r => r.id)).toEqual(['4']);
    });

    it('stops at maxResults', async () => {
      const results = await storage.searchContent('apple', undefined, 2);
      expect(results).toHaveLength(2);
    });

    it('returns nothing when no match', async () => {
      expect(await storage.searchContent('cherry')).toEqual([]);
    });
  });
});
