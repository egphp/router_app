import { closeDb, getDb, runMigrations } from '@tenda/shared';
import { rebuildTrafficFromSamples } from './traffic-rebuilder.js';

runMigrations();
const db = getDb();
const result = rebuildTrafficFromSamples(db, {
  now: Date.now(),
  normalizeSpeeds: true,
  replaceAll: true,
});

console.log(JSON.stringify(result, null, 2));
closeDb();
