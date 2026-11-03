export interface Env {
  DB: D1Database;
  BOT_INGEST_TOKEN: string;
  BOT_ADMIN_TOKEN: string;
  AURA_API_URL: string;
  AURA_SERVICE_TOKEN: string;
  ENVIRONMENT?: string;
}

export interface AdminContext {
  email: string;
}
