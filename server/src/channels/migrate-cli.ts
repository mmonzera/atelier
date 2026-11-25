import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyGroupChatMigration, planGroupChatMigration } from './migration.js';

function parseArgs(argv: string[]): { dryRun: boolean; dbPath: string } {
  let dryRun = false;
  let dbPath = path.resolve(process.cwd(), 'data', 'atelier.db');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--db' && argv[i + 1]) {
      dbPath = path.resolve(argv[i + 1]!);
      i += 1;
    }
  }
  return { dryRun, dbPath };
}

const { dryRun, dbPath } = parseArgs(process.argv.slice(2));
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const sqlite = new DatabaseSync(dbPath, { readOnly: dryRun });
try {
  if (dryRun) {
    const plan = planGroupChatMigration(sqlite);
    const outDir = path.join(path.dirname(dbPath), 'migrations');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `group-chat-plan-${stamp}.json`);
    fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), 'utf8');
    console.log(JSON.stringify({ dryRun: true, planPath: outPath, ...plan }, null, 2));
  } else {
    const plan = applyGroupChatMigration(sqlite, { dataDir: path.dirname(dbPath) });
    console.log(JSON.stringify({ dryRun: false, plan }, null, 2));
  }
} finally {
  sqlite.close();
}
