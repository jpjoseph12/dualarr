// Keeps the Unraid / Community Applications files honest: well-formed XML, the fields CA needs,
// and every URL or setting in them pointing at something that really exists in this repo.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const exists = (p) => fs.existsSync(new URL(`../${p}`, import.meta.url));
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

/** One Unraid template's fields and settings. */
function parse(file) {
  const xml = read(file);
  const field = (tag) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1].trim();
  const all = (tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1].trim());
  const configs = [...xml.matchAll(/<Config ([^>]*)>([^<]*)<\/Config>/g)].map((m) => ({
    ...Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
    value: m[2],
  }));
  return { file, xml, field, all, configs, vars: Object.fromEntries(configs.filter((c) => c.Type === 'Variable').map((c) => [c.Target, c.Default])) };
}
const TEMPLATES = { main: parse('templates/dualarr.xml'), nvidia: parse('templates/dualarr-nvidia.xml') };

for (const t of Object.values(TEMPLATES)) {
  describe(t.file, () => {
    test('is well-formed and has what Community Applications needs', () => {
      assertWellFormed(t.xml, t.file);
      assert.match(t.xml, /^<\?xml version="1.0"\?>\s*<Container version="2">/);
      for (const tag of ['Name', 'Repository', 'Registry', 'Network', 'Overview', 'Category', 'WebUI', 'TemplateURL', 'Icon', 'Project', 'Support', 'License']) {
        assert.ok(t.field(tag), `<${tag}> is set`);
      }
      assert.equal(t.field('Privileged'), 'false');
      assert.equal(t.field('Network'), 'bridge');
      assert.ok(t.field('Overview').length > 100, 'a real description');
      assert.match(t.field('Date'), /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(t.field('Changes').includes(t.field('Date')), 'changelog mentions the current date');
      assert.ok(t.field('Changes').includes(`### ${JSON.parse(read('package.json')).version} `), 'changelog has the current version');
      assert.equal(t.field('License'), 'MIT');
    });

    test('every raw GitHub URL points at a file in this repo', () => {
      const urls = [t.field('TemplateURL'), t.field('Icon'), t.field('ReadMe'), ...t.all('Screenshot')];
      for (const u of urls) {
        assert.ok(u.startsWith(RAW), `${u} is a raw URL on main`);
        assert.ok(exists(u.slice(RAW.length)), `${u.slice(RAW.length)} exists`);
      }
      assert.equal(t.field('TemplateURL'), `${RAW}${t.file}`, 'TemplateURL is this exact file');
      assert.ok(t.all('Screenshot').length >= 1);
    });

    test('port, paths and variables match what the container really uses', () => {
      const port = t.configs.find((c) => c.Type === 'Port');
      const dockerfile = read('Dockerfile');
      assert.equal(port.Target, '6162');
      assert.match(dockerfile, /EXPOSE 6162/);
      assert.match(t.field('WebUI'), /\[PORT:6162\]/);
      const appdata = t.configs.find((c) => c.Target === '/config');
      assert.deepEqual([appdata.Type, appdata.Mode, appdata.Default], ['Path', 'rw', '/mnt/user/appdata/dualarr']);
      assert.match(dockerfile, /CONFIG_DIR=\/config/);
      // The media folder is optional and read-only: Dualarr never writes to it.
      const media = t.configs.find((c) => c.Target === '/media');
      assert.deepEqual([media.Type, media.Mode, media.Required, media.Default], ['Path', 'ro', 'false', '']);
      const entrypoint = read('docker/entrypoint.sh');
      for (const v of ['PUID', 'PGID', 'UMASK']) assert.ok(entrypoint.includes(v), `entrypoint reads ${v}`);
      assert.ok(read('server/index.js').includes('DUALARR_RESET_AUTH'), 'the app reads DUALARR_RESET_AUTH');
      for (const c of t.configs) assert.ok(c.Description?.length > 10, `${c.Name} has a description`);
    });
  });
}

describe('GPUs', () => {
  test('the main template: CPU, or an Intel/AMD iGPU through /dev/dri', () => {
    const t = TEMPLATES.main;
    assert.equal(t.field('Repository'), 'ghcr.io/jpjoseph12/dualarr:latest');
    assert.deepEqual(t.vars, { PUID: '99', PGID: '100', DUALARR_RESET_AUTH: 'false', UMASK: '002' });
    const dri = t.configs.find((c) => c.Type === 'Device');
    // Empty by default: a --device that doesn't exist on the host stops the container starting.
    assert.deepEqual([dri.Target, dri.Default, dri.Required], ['/dev/dri', '', 'false']);
    assert.ok(!t.field('ExtraParams'), 'no NVIDIA runtime');
    assert.match(read('docker/entrypoint.sh'), /\/dev\/dri\/\*/, 'the app joins the render group');
  });

  test('the NVIDIA template: the CUDA image with the NVIDIA runtime', () => {
    const t = TEMPLATES.nvidia;
    assert.equal(t.field('Name'), 'Dualarr-NVIDIA');
    assert.equal(t.field('Repository'), 'ghcr.io/jpjoseph12/dualarr:latest-cuda');
    assert.equal(t.field('ExtraParams'), '--runtime=nvidia');
    assert.deepEqual(t.vars, { NVIDIA_VISIBLE_DEVICES: 'all', NVIDIA_DRIVER_CAPABILITIES: 'compute,utility', PUID: '99', PGID: '100', DUALARR_RESET_AUTH: 'false', UMASK: '002' });
    assert.ok(!t.configs.some((c) => c.Type === 'Device'));
    assert.match(t.field('Requires'), /Nvidia-Driver plugin/);
  });

  test('CI publishes both images, and the Dockerfile builds both', () => {
    const ci = read('.github/workflows/docker.yml');
    assert.match(ci, /images: ghcr\.io\/\$\{\{ github\.repository \}\}/);
    assert.match(ci, /suffix: ''/);
    assert.match(ci, /suffix: -cuda/);
    const dockerfile = read('Dockerfile');
    assert.match(dockerfile, /FROM whisper-\$\{GPU\} AS whisper/);
    // CUDA 13 dropped the GTX 10 series.
    assert.match(dockerfile, /nvidia\/cuda:12\.[\d.]+-devel/);
    assert.match(dockerfile, /CMAKE_CUDA_ARCHITECTURES="[^"]*61-real/);
  });
});

test('the CA profile and licence', () => {
  assertWellFormed(profile, 'ca_profile.xml');
  assert.ok(profile.match(/<Profile>([\s\S]*?)<\/Profile>/)[1].trim().length > 50, 'non-empty <Profile>');
  assert.ok(exists(profile.match(/<Icon>(.*?)<\/Icon>/)[1].slice(RAW.length)));
  assert.match(read('LICENSE'), /^MIT License/, 'OSI-approved licence at the repo root');
});
