/**
 * Local escape hatch when both the app-lock password and the recovery key are lost:
 *
 *   npm run lock:reset                 (dev / source checkout, uses ATELIER_DATA_DIR or ./data)
 *   Atelier.exe --reset-lock           (installed desktop app, uses %APPDATA%\Atelier)
 *
 * Anyone who can run this already has full access to the data folder, so it only removes the
 * lock (it never reveals data). Stop Atelier first; the server keeps sessions in memory.
 */
import { loadConfig } from '../config.js';
import { AtelierDb } from '../db.js';
import { resetLockDirect } from '../security/vault.js';

export function runResetLock(dataDir?: string): { dbPath: string; removed: boolean } {
  const config = loadConfig(dataDir ? { dataDir } : undefined);
  const db = new AtelierDb(config.dbPath);
  try {
    return { dbPath: config.dbPath, removed: resetLockDirect(db) };
  } finally {
    db.close();
  }
}

const isMain = !process.versions.electron && process.argv[1] && /reset-lock\.(t|j)s$/.test(process.argv[1]);
if (isMain) {
  const argDir = process.argv.find((a) => a.startsWith('--data-dir='))?.slice('--data-dir='.length);
  const { dbPath, removed } = runResetLock(argDir);
  console.log(
    removed
      ? `App lock dimatikan untuk ${dbPath}. Jalankan ulang Atelier lalu aktifkan lagi dari Settings bila perlu.`
      : `App lock memang tidak aktif di ${dbPath}.`,
  );
}
