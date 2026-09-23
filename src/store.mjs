/**
 * Plány nahrávání a sledované události: malé JSON soubory v DATA_DIR.
 *
 * Na Netlify to byly Blobs; tady stačí soubor. Zapisuje se do dočasného
 * souboru a přejmenuje se, takže výpadek uprostřed zápisu nenechá rozbitý JSON.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function createStore(dir = process.env.DATA_DIR || path.resolve('data')) {
  const soubor = (name) => path.join(dir, `${name}.json`);
  return {
    async nacti(name) {
      try { return JSON.parse(await readFile(soubor(name), 'utf8')) || {}; }
      catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    },
    async uloz(name, data) {
      await mkdir(dir, { recursive: true });
      const tmp = soubor(name) + '.' + process.pid + '.tmp';
      await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(tmp, soubor(name));
    },
  };
}
