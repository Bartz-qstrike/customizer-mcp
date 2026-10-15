import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // McpController reads and parses request bodies itself, whatever their
  // Content-Type; Nest's parsers would otherwise consume them first.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
