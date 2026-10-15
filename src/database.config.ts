// Single source of truth for DB connection settings. Built from discrete
// DATABASE_* variables instead of a DATABASE_URL.
export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function databaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const database = env.DATABASE_NAME;
  if (!database) {
    throw new Error('DATABASE_NAME is not set');
  }
  return {
    host: env.DATABASE_HOST ?? '127.0.0.1',
    port: Number(env.DATABASE_PORT ?? 3306),
    user: env.DATABASE_USER ?? 'root',
    password: env.DATABASE_PASSWORD ?? '',
    database,
  };
}

// Prisma CLI (migrate, db pull, studio) still needs a connection string, so
// assemble one from the parts. The app itself never reads this.
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const { host, port, user, password, database } = databaseConfig(env);
  const auth = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  return `mysql://${auth}@${host}:${port}/${encodeURIComponent(database)}`;
}
