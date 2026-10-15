import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import { PrismaClient } from '../generated/prisma/client.js';
import { databaseConfig } from '../database.config.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService) {
    const db = databaseConfig({
      DATABASE_HOST: config.get('DATABASE_HOST'),
      DATABASE_PORT: config.get('DATABASE_PORT'),
      DATABASE_USER: config.get('DATABASE_USER'),
      DATABASE_PASSWORD: config.get('DATABASE_PASSWORD'),
      DATABASE_NAME: config.get('DATABASE_NAME'),
    });
    super({
      adapter: new PrismaMariaDb({
        ...db,
        connectionLimit: 5,
        // MySQL 8+/9 default auth (caching_sha2_password) over non-TLS.
        allowPublicKeyRetrieval: true,
      }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
