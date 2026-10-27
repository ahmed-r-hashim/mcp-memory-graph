import { StorageFactory } from './StorageFactory.js';
import { StorageType } from './MemoryStorage.js';
import { JsonMemoryStorage } from './JsonMemoryStorage.js';
import { SqliteMemoryStorage } from './SqliteMemoryStorage.js';
import { MariaDbMemoryStorage } from './MariaDbMemoryStorage.js';

describe('StorageFactory', () => {
  it('creates JSON storage', () => {
    expect(StorageFactory.createStorage(StorageType.JSON, 'dir')).toBeInstanceOf(JsonMemoryStorage);
  });

  it('creates SQLite storage', () => {
    expect(StorageFactory.createStorage(StorageType.SQLITE, 'dir')).toBeInstanceOf(SqliteMemoryStorage);
  });

  it('creates MariaDB storage', () => {
    expect(StorageFactory.createStorage(StorageType.MARIADB, 'dir', { host: 'h' })).toBeInstanceOf(MariaDbMemoryStorage);
  });

  it('throws for unknown types', () => {
    expect(() => StorageFactory.createStorage('nope' as StorageType, 'dir')).toThrow('Unknown storage type: nope');
  });
});
