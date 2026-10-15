import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPool, type Pool } from 'mariadb';
import { databaseConfig } from '../database.config.js';

// Runs ad-hoc SQL inside a READ ONLY transaction that is always rolled back,
// so MySQL itself rejects writes regardless of what the statement looks like.
@Injectable()
export class ReadOnlySqlService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    const db = databaseConfig({
      DATABASE_HOST: config.get('DATABASE_HOST'),
      DATABASE_PORT: config.get('DATABASE_PORT'),
      DATABASE_USER: config.get('DATABASE_USER'),
      DATABASE_PASSWORD: config.get('DATABASE_PASSWORD'),
      DATABASE_NAME: config.get('DATABASE_NAME'),
    });
    this.pool = createPool({
      ...db,
      connectionLimit: 3,
      allowPublicKeyRetrieval: true,
      bigIntAsNumber: false,
      dateStrings: true,
    });
  }

  async query(sql: string): Promise<unknown[]> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query('START TRANSACTION READ ONLY');
      const rows: unknown = await conn.query(sql);
      return Array.isArray(rows) ? [...rows] : [rows];
    } finally {
      await conn.query('ROLLBACK').catch(() => undefined);
      await conn.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
