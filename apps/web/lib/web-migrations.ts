import { runMigrations } from '@tenda/shared';

let migrated = false;

export function ensureWebMigrations(): void {
  if (migrated) return;
  runMigrations();
  migrated = true;
}
