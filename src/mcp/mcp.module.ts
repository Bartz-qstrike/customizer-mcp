import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';
import { ReadOnlySqlService } from './read-only-sql.service.js';

@Module({
  controllers: [McpController],
  providers: [McpService, ReadOnlySqlService],
})
export class McpModule {}
