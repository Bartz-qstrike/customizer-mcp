import { Module } from '@nestjs/common';
import { BearerAuthGuard } from '../auth/bearer-auth.guard.js';
import { StylesModule } from '../styles/styles.module.js';
import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';
import { ReadOnlySqlService } from './read-only-sql.service.js';

@Module({
  imports: [StylesModule],
  controllers: [McpController],
  providers: [McpService, ReadOnlySqlService, BearerAuthGuard],
})
export class McpModule {}
