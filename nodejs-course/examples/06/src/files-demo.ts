import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'node-course-06-'));
  try {
    const filename = join(directory, 'note.txt');
    await writeFile(filename, '中🙂', { encoding: 'utf8', flag: 'wx' });
    const data = await readFile(filename);
    console.log(JSON.stringify({ isBuffer: Buffer.isBuffer(data), bytes: data.length, text: data.toString('utf8') }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
