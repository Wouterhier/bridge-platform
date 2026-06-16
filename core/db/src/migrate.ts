#!/usr/bin/env node
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

interface MigrationRow {
  filename: string;
  applied_at: Date;
}

async function ensureMigrationsTable(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(client: Client): Promise<Set<string>> {
  const result = await client.query<MigrationRow>('SELECT filename FROM _migrations ORDER BY filename');
  return new Set(result.rows.map((row) => row.filename));
}

async function listMigrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function runMigrations() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);

    const applied = await getAppliedMigrations(client);
    const files = await listMigrationFiles();

    if (files.length === 0) {
      console.log('No migration files found.');
      await client.query('COMMIT');
      return;
    }

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`Skipping ${file} (already applied)`);
        continue;
      }

      const path = join(MIGRATIONS_DIR, file);
      const sql = await readFile(path, 'utf-8');
      console.log(`Applying ${file} ...`);
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      appliedCount++;
    }

    await client.query('COMMIT');
    console.log(`Applied ${appliedCount} migration(s).`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function showStatus() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const files = await listMigrationFiles();

    for (const file of files) {
      const status = applied.has(file) ? 'applied' : 'pending';
      console.log(`[${status}] ${file}`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    await showStatus();
  } else {
    await runMigrations();
  }
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
