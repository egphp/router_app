import 'server-only';
import { getDb } from '@tenda/shared';

export function db() {
  return getDb();
}
