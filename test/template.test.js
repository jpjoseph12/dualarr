// Keeps the Unraid / Community Applications files honest: well-formed XML, the fields CA needs,
// and every URL or setting in them pointing at something that really exists in this repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const exists = (p) => fs.existsSync(new URL(`../${p}`, import.meta.url));
const template = read('templates/dualarr.xml');
const profile = read('ca_profile.xml');
const RAW = 'https://raw.githubusercontent.com/jpjoseph12/dualarr/main/';

/** A small well-formedness check: every opened tag closes, in order. */
function assertWellFormed(xml, name) {
  const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, , selfClosing] = m;
    if (selfClosing) continue;
    if (closing) assert.equal(stack.pop(), tag, `${name}: </${tag}> closes the wrong element`);
    else stack.push(tag);
  }
  assert.deepEqual(stack, [], `${name}: unclosed <${stack.at(-1)}>`);
  assert.doesNotMatch(body.replace(/<[^>]+>/g, ''), /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/, `${name}: unescaped &`);
}

const field = (tag) => template.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1].trim();
const all = (tag) => [...template.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1].trim());
const configs = [...template.matchAll(/<Config ([^>]*)>([^<]*)<\/Config>/g)].map((m) => ({
  ...Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
  value: m[2],
}));

test('template and profile are well-formed', () => {
  assertWellFormed(template, 'templates/dualarr.xml');
  assertWellFormed(profile, 'ca_profile.xml');
  assert.match(template, /^<\?xml version="1.0"\?>\s*<Container version="2">/);
});

test('template has what Community Applications needs', () => {
  for (const tag of ['Name', 'Repository', 'Registry', 'Network', 'Overview', 'Category', 'WebUI', 'TemplateURL', 'Icon', 'Project', 'Support', 'License']) {
    assert.ok(field(tag), `<${tag}> is set`);
  }
  assert.equal(field('Privileged'), 'false');
  assert.equal(field('Network'), 'bridge');
  assert.ok(field('Overview').length > 100, 'a real description');
  assert.match(field('Date'), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(field('Changes').includes(field('Date')), 'changelog mentions the current date');
  assert.match(read('LICENSE'), /^MIT License/, 'OSI-approved licence at the repo root');
  assert.equal(field('License'), 'MIT');
  assert.ok(profile.match(/<Profile>([\s\S]*?)<\/Profile>/)[1].trim().length > 50, 'non-empty <Profile>');
});

test('the image is the one CI publishes', () => {
  assert.equal(field('Repository'), 'ghcr.io/jpjoseph12/dualarr:latest');
  assert.match(read('.github/workflows/docker.yml'), /images: ghcr\.io\/\$\{\{ github\.repository \}\}/);
});

test('every raw GitHub URL points at a file in this repo', () => {
  const urls = [field('TemplateURL'), field('Icon'), field('ReadMe'), ...all('Screenshot'), profile.match(/<Icon>(.*?)<\/Icon>/)[1]];
  for (const u of urls) {
    assert.ok(u.startsWith(RAW), `${u} is a raw URL on main`);
    assert.ok(exists(u.slice(RAW.length)), `${u.slice(RAW.length)} exists`);
  }
  assert.equal(field('TemplateURL'), `${RAW}templates/dualarr.xml`, 'TemplateURL is this exact file');
  assert.ok(all('Screenshot').length >= 1);
});

test('port, paths and variables match what the container really uses', () => {
  const port = configs.find((c) => c.Type === 'Port');
  const dockerfile = read('Dockerfile');
  assert.equal(port.Target, '6162');
  assert.match(dockerfile, /EXPOSE 6162/);
  assert.match(field('WebUI'), /\[PORT:6162\]/);
  const appdata = configs.find((c) => c.Target === '/config');
  assert.deepEqual([appdata.Type, appdata.Mode, appdata.Default], ['Path', 'rw', '/mnt/user/appdata/dualarr']);
  assert.match(dockerfile, /CONFIG_DIR=\/config/);
  const vars = Object.fromEntries(configs.filter((c) => c.Type === 'Variable').map((c) => [c.Target, c.Default]));
  assert.deepEqual(vars, { PUID: '99', PGID: '100', DUALARR_RESET_AUTH: 'false', UMASK: '002' });
  const entrypoint = read('docker/entrypoint.sh');
  for (const v of ['PUID', 'PGID', 'UMASK']) assert.ok(entrypoint.includes(v), `entrypoint reads ${v}`);
  assert.ok(read('server/index.js').includes('DUALARR_RESET_AUTH'), 'the app reads DUALARR_RESET_AUTH');
  for (const c of configs) assert.ok(c.Description?.length > 10, `${c.Name} has a description`);
});
