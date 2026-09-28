import path from 'node:path';
import fs from 'node:fs';

export const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || '/config');
export const PORT = Number(process.env.PORT) || 6162;
export const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

fs.mkdirSync(CONFIG_DIR, { recursive: true });

export const log = (...args) => console.log(new Date().toISOString(), ...args);
