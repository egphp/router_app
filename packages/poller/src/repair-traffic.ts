import { closeDb, getDb, runMigrations } from '@tenda/shared';
import { rebuildTrafficFromSamples } from './traffic-rebuilder.js';

runMigrations();
const db = getDb();
const wipeAll = process.argv.includes('--wipe-all');
const result = rebuildTrafficFromSamples(db, {
  now: Date.now(),
  normalizeSpeeds: true,
  replaceAll: wipeAll,
});

console.log(JSON.stringify({ mode: wipeAll ? 'wipe-all' : 'windowed-safe', ...result }, null, 2));
closeDb();
