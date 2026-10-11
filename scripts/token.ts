import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDir } from '../src/server.ts';

process.stdout.write((await readFile(join(stateDir, 'token'), 'utf8')).trim());
