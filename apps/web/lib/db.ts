import 'server-only';
import { getDb } from '@tenda/shared';
import { ensureWebMigrations } from './web-migrations';

export function db() {
  ensureWebMigrations();
  return getDb();
}
