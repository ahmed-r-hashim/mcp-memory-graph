import mysql from 'mysql2/promise';
import { MariaDbMemoryStorage } from './MariaDbMemoryStorage.js';
import { DomainInfo, MemoryNode } from '../types/graph.js';

const ts = '2024-01-01T00:00:00.000Z';
const domain = (id: string): DomainInfo => ({ id, name: id, description: 'd', created: ts, lastAccess: ts });

type ExecuteHandler = (sql: string, params?: any[]) => any;

function createMocks(handler: ExecuteHandler = () => [[], []]) {
  const conn = {
    execute: jest.fn(async (sql: string, params?: any[]) => handler(sql, params)),
    release: jest.fn(),
    beginTransaction: jest.fn(async () => undefined),
    commit: jest.fn(async () => undefined),
    rollback: jest.fn(async () => undefined),
  };
  const pool = {
    getConnection: jest.fn(async () => conn),
    end: jest.fn(async () => undefined),
  };
  const createPool = jest.spyOn(mysql, 'createPool').mockReturnValue(pool as any);
  return { conn, pool, createPool };
}

describe('MariaDbMemoryStorage', () => {
  const envKeys = ['MARIADB_HOST', 'MARIADB_USER', 'MARIADB_PASSWORD', 'MARIADB_DATABASE'];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    envKeys.forEach(k => { savedEnv[k] = process.env[k]; delete process.env[k]; });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    envKeys.forEach(k => {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    });
  });

  describe('configuration', () => {
    it('uses defaults when env and config are absent', () => {
      const cfg = (new MariaDbMemoryStorage('dir') as any).config;
      expect(cfg).toMatchObject({ host: 'localhost', user: 'root', password: '', database: 'memory_graph' });
    });

    it('reads configuration from env', () => {
      process.env.MARIADB_HOST = 'db';
      process.env.MARIADB_USER = 'u';
      process.env.MARIADB_PASSWORD = 'p';
      process.env.MARIADB_DATABASE = 'd';
      const cfg = (new MariaDbMemoryStorage('dir') as any).config;
      expect(cfg).toMatchObject({ host: 'db', user: 'u', password: 'p', database: 'd' });
    });

    it('prefers explicit config', () => {
      const cfg = (new MariaDbMemoryStorage('dir', { host: 'explicit' }) as any).config;
      expect(cfg).toEqual({ host: 'explicit' });
    });
  });

  describe('initialize', () => {
    it('creates database, schema, function and view', async () => {
      const { conn, pool, createPool } = createMocks();
      await new MariaDbMemoryStorage('dir', { database: 'mg' }).initialize();

      const sqls = conn.execute.mock.calls.map(c => c[0] as string);
      expect(sqls.some(s => s.includes('CREATE DATABASE IF NOT EXISTS mg'))).toBe(true);
      expect(sqls.some(s => s.includes('CREATE TABLE IF NOT EXISTS DOMAINS'))).toBe(true);
      expect(sqls.some(s => s.includes('CREATE FUNCTION get_node_tags'))).toBe(true);
      expect(sqls.some(s => s.includes('CREATE OR REPLACE VIEW memory_content_search'))).toBe(true);
      expect(pool.end).toHaveBeenCalled();
      expect(conn.release).toHaveBeenCalled();
      // Temp pool for DB creation must not carry the database name
      expect(createPool.mock.calls[0][0]).not.toHaveProperty('database');
    });

    it('skips function creation when it already exists', async () => {
      const { conn } = createMocks(sql =>
        sql.includes('INFORMATION_SCHEMA.ROUTINES') ? [[{ ROUTINE_NAME: 'get_node_tags' }], []] : [[], []]
      );
      await new MariaDbMemoryStorage('dir', { database: 'mg' }).initialize();
      const sqls = conn.execute.mock.calls.map(c => c[0] as string);
      expect(sqls.some(s => s.includes('CREATE FUNCTION get_node_tags'))).toBe(false);
    });

    it('releases the connection when schema creation fails', async () => {
      const { conn } = createMocks(sql => {
        if (sql.includes('FOREIGN_KEY_CHECKS')) throw new Error('boom');
        return [[], []];
      });
      await expect(new MariaDbMemoryStorage('dir', { database: 'mg' }).initialize()).rejects.toThrow('boom');
      expect(conn.release).toHaveBeenCalled();
    });

    it('ends the temp pool even if connecting fails', async () => {
      const { pool } = createMocks();
      pool.getConnection.mockRejectedValueOnce(new Error('no connect'));
      await expect(new MariaDbMemoryStorage('dir', { database: 'mg' }).initialize()).rejects.toThrow('no connect');
      expect(pool.end).toHaveBeenCalled();
    });
  });

  describe('searchContent', () => {
    const rows = [{ id: 'n1', content: 'c', timestamp: ts, path: '/', content_summary: 's', summary_timestamp: ts }];

    it('queries with a cleaned term and hydrates tags and refs', async () => {
      const { conn } = createMocks(sql => {
        if (sql.includes('MATCH(')) return [rows, []];
        if (sql.includes('MEMORY_TAGS')) return [[{ tag: 't1' }], []];
        if (sql.includes('DOMAIN_REFS')) return [[{ targetDomain: 'd2', targetNodeId: 'x', description: 'r', bidirectional: 1 }], []];
        return [[], []];
      });
      const storage = new MariaDbMemoryStorage('dir', { database: 'mg' });
      const results = await storage.searchContent('+foo -bar* "baz"', 'dom', 5);

      expect(results).toEqual([{
        id: 'n1', content: 'c', timestamp: ts, path: '/', content_summary: 's', summary_timestamp: ts,
        tags: ['t1'],
        domainRefs: [{ domain: 'd2', nodeId: 'x', description: 'r', bidirectional: true }],
      }]);
      const [sql, params] = conn.execute.mock.calls[0];
      expect(sql).toContain('AND m.domain = ?');
      expect(params).toEqual([expect.stringMatching(/^foo\s+bar\s+baz$/), 'dom', 5]);
      expect(conn.release).toHaveBeenCalled();
    });

    it('omits empty tags and refs and the domain filter', async () => {
      const { conn } = createMocks(sql => (sql.includes('MATCH(') ? [rows, []] : [[], []]));
      const results = await new MariaDbMemoryStorage('dir').searchContent('foo');
      expect(results[0].tags).toBeUndefined();
      expect(results[0].domainRefs).toBeUndefined();
      expect(conn.execute.mock.calls[0][0]).not.toContain('m.domain');
      expect(conn.execute.mock.calls[0][1]).toEqual(['foo', 20]);
    });

    it('returns an empty array when the driver result is not an array', async () => {
      const { conn } = createMocks(() => [{ affectedRows: 0 }, []]);
      expect(await new MariaDbMemoryStorage('dir').searchContent('foo')).toEqual([]);
      expect(conn.release).toHaveBeenCalled();
    });
  });

  describe('DatabaseStorage behaviour', () => {
    it('getDomains maps rows', async () => {
      createMocks(() => [[domain('a')], []]);
      const domains = await new MariaDbMemoryStorage('dir').getDomains();
      expect(domains.get('a')).toEqual(domain('a'));
    });

    it('createDomain issues an insert', async () => {
      const { conn } = createMocks();
      await new MariaDbMemoryStorage('dir').createDomain(domain('a'));
      expect(conn.execute.mock.calls[0][0]).toContain('INSERT INTO DOMAINS');
    });

    it('saveDomains commits on success and rolls back on failure', async () => {
      const ok = createMocks();
      await new MariaDbMemoryStorage('dir').saveDomains(new Map([['a', domain('a')]]));
      expect(ok.conn.beginTransaction).toHaveBeenCalled();
      expect(ok.conn.commit).toHaveBeenCalled();
      jest.restoreAllMocks();

      const bad = createMocks(() => { throw new Error('boom'); });
      await expect(new MariaDbMemoryStorage('dir').saveDomains(new Map())).rejects.toThrow('boom');
      expect(bad.conn.rollback).toHaveBeenCalled();
    });

    it('getPersistenceState returns the row or throws when absent', async () => {
      createMocks(() => [[{ currentDomain: 'g', lastAccess: ts, lastMemoryId: 'm' }], []]);
      expect(await new MariaDbMemoryStorage('dir').getPersistenceState())
        .toEqual({ currentDomain: 'g', lastAccess: ts, lastMemoryId: 'm' });
      jest.restoreAllMocks();

      createMocks(() => [[], []]);
      await expect(new MariaDbMemoryStorage('dir').getPersistenceState()).rejects.toThrow('Persistence state not found');
    });

    it('savePersistenceState updates when a row exists and inserts otherwise', async () => {
      const upd = createMocks(sql => (sql.startsWith('SELECT 1') ? [[{ 1: 1 }], []] : [[], []]));
      const state = { currentDomain: 'g', lastAccess: ts };
      await new MariaDbMemoryStorage('dir').savePersistenceState(state);
      expect(upd.conn.execute.mock.calls[1][0]).toContain('UPDATE PERSISTENCE');
      jest.restoreAllMocks();

      const ins = createMocks();
      await new MariaDbMemoryStorage('dir').savePersistenceState(state);
      expect(ins.conn.execute.mock.calls[1][0]).toContain('INSERT INTO PERSISTENCE');
    });

    it('getMemories hydrates nodes and edges', async () => {
      createMocks(sql => {
        if (sql.includes('FROM MEMORY_NODES')) return [[{ id: 'n1', content: 'c', timestamp: ts, path: '/' }], []];
        if (sql.includes('FROM MEMORY_TAGS')) return [[{ tag: 't' }], []];
        if (sql.includes('FROM DOMAIN_REFS')) return [[{ targetDomain: 'd', targetNodeId: 'x', description: null, bidirectional: 0 }], []];
        if (sql.includes('FROM MEMORY_EDGES')) return [[{ source: 'n1', target: 'n2', type: 'relates_to', strength: 0.5, timestamp: ts }], []];
        return [[], []];
      });
      const { nodes, edges } = await new MariaDbMemoryStorage('dir').getMemories('general');
      expect(nodes.get('n1')?.tags).toEqual(['t']);
      expect(nodes.get('n1')?.domainRefs?.[0].bidirectional).toBe(false);
      expect(edges).toHaveLength(1);
    });

    it('saveMemories uses MariaDB insert dialects', async () => {
      const { conn } = createMocks();
      const nodes = new Map<string, MemoryNode>([['n1', {
        id: 'n1', content: 'c', timestamp: ts, tags: ['t'],
        domainRefs: [{ domain: 'd', nodeId: 'x', bidirectional: true }],
      }]]);
      await new MariaDbMemoryStorage('dir').saveMemories('general', nodes, [
        { source: 'n1', target: 'n2', type: 'relates_to', strength: 1, timestamp: ts },
      ]);
      const sqls = conn.execute.mock.calls.map(c => c[0] as string);
      expect(sqls.some(s => s.startsWith('INSERT IGNORE INTO MEMORY_TAGS'))).toBe(true);
      expect(sqls.some(s => s.startsWith('INSERT IGNORE INTO DOMAIN_REFS'))).toBe(true);
      expect(sqls.some(s => s.startsWith('REPLACE INTO MEMORY_EDGES'))).toBe(true);
      expect(conn.commit).toHaveBeenCalled();
    });

    it('maps booleans using truthiness', () => {
      const s = new MariaDbMemoryStorage('dir') as any;
      expect(s.getBooleanValue(1)).toBe(true);
      expect(s.getBooleanValue(0)).toBe(false);
      expect(s.setBooleanValue(true)).toBe(true);
      expect(s.setBooleanValue(undefined)).toBe(false);
    });
  });

  describe('close', () => {
    it('ends the pool when open', async () => {
      const { pool } = createMocks();
      const storage = new MariaDbMemoryStorage('dir');
      await storage.getDomains();
      await storage.close();
      expect(pool.end).toHaveBeenCalledTimes(1);
      await storage.close();
      expect(pool.end).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when never connected', async () => {
      await expect(new MariaDbMemoryStorage('dir').close()).resolves.toBeUndefined();
    });
  });
});
