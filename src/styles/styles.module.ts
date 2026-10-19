import { Module } from '@nestjs/common';
import { StyleToolsService } from './style-tools.service.js';

@Module({
  providers: [StyleToolsService],
  exports: [StyleToolsService],
})
export class StylesModule {}
