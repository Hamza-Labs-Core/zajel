/**
 * Storage Factory
 *
 * Creates the appropriate storage backend based on configuration.
 * Uses dynamic imports so only the selected backend's native module
 * (better-sqlite3 or pg) needs to be installed.
 */

import type { Storage } from './interface.js';

interface StorageConfig {
  type: 'sqlite' | 'postgres';
  path: string;
  databaseUrl?: string;
  poolSize?: number;
}

export async function createStorage(config: StorageConfig): Promise<Storage> {
  if (config.type === 'postgres') {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required when STORAGE_BACKEND=postgres');
    }
    const { PostgresStorage } = await import('./postgres.js');
    const storage = new PostgresStorage(config.databaseUrl, {
      max: config.poolSize,
    });
    await storage.init();
    return storage;
  }

  // Default: SQLite
  const { SQLiteStorage } = await import('./sqlite.js');
  const storage = new SQLiteStorage(config.path);
  await storage.init();
  return storage;
}
