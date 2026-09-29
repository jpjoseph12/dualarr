// Turns lcov.info into a Markdown table (used for the GitHub Actions job summary).
//   node test/coverage-summary.mjs [lcov.info]
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] || 'lcov.info';
if (!fs.existsSync(file)) {
  console.log('_No coverage data (tests did not produce lcov.info)._');
  process.exit(0);
}

const rows = [];
let cur = null;
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  const [key, val] = line.split(':');
  if (key === 'SF') cur = { file: path.relative(process.cwd(), val).replaceAll('\\', '/'), lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
  else if (cur && ['LF', 'LH', 'BRF', 'BRH', 'FNF', 'FNH'].includes(key)) cur[key.toLowerCase()] = Number(val);
  else if (key === 'end_of_record' && cur) {
    rows.push(cur);
    cur = null;
  }
}

const pct = (hit, found) => (found ? ((hit / found) * 100).toFixed(1) : '100.0');
const total = rows.reduce((t, r) => ({ lf: t.lf + r.lf, lh: t.lh + r.lh, brf: t.brf + r.brf, brh: t.brh + r.brh, fnf: t.fnf + r.fnf, fnh: t.fnh + r.fnh }), { lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 });

const out = [
  '### Test coverage',
  '',
  '| File | Lines | Branches | Functions |',
  '|---|---:|---:|---:|',
  ...rows.sort((a, b) => a.file.localeCompare(b.file)).map((r) => `| \`${r.file}\` | ${pct(r.lh, r.lf)}% | ${pct(r.brh, r.brf)}% | ${pct(r.fnh, r.fnf)}% |`),
  `| **All files** | **${pct(total.lh, total.lf)}%** | **${pct(total.brh, total.brf)}%** | **${pct(total.fnh, total.fnf)}%** |`,
];
console.log(out.join('\n'));
