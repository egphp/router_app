import { runMigrations, closeDb } from './db.js';

runMigrations();
closeDb();
console.log('[migrate] done');
