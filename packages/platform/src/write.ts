import { constants } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';

export class OutputExistsError extends Error {
  constructor(path: string) {
    super(`${path} already exists; pass --overwrite to replace it`);
    this.name = 'OutputExistsError';
  }
}

/** Writes report files, refusing to replace existing ones unless overwrite is set. */
export async function writeReportFiles(outDir: string, files: Record<string, string>, overwrite: boolean): Promise<string[]> {
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const outDirStat = await stat(outDir);
  if (!outDirStat.isDirectory()) throw new Error(`${outDir} is not a directory`);
  if (!overwrite) {
    for (const name of Object.keys(files)) {
      const p = join(outDir, name);
      const exists = await stat(p).then(() => true, () => false);
      if (exists) throw new OutputExistsError(p);
    }
  }
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const p = join(outDir, name);
    const flags = overwrite
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW
      : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const fh = await open(p, flags, 0o600);
    try {
      await fh.writeFile(content, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    written.push(p);
  }
  return written;
}
