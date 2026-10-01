import { log } from './config.js';

// Notification targets. Each is { id, type, name, enabled, ...fields }; the secret fields are
// masked when sent to the browser (see SECRET_FIELDS).
export const NOTIFIER_TYPES = {
  discord: { label: 'Discord', fields: ['webhookUrl'] },
  telegram: { label: 'Telegram', fields: ['botToken', 'chatId'] },
  ntfy: { label: 'ntfy', fields: ['server', 'topic', 'token'] },
  gotify: { label: 'Gotify', fields: ['server', 'token'] },
  webhook: { label: 'Webhook (JSON)', fields: ['url'] },
};
export const SECRET_FIELDS = ['webhookUrl', 'botToken', 'token'];

const COLOR = { upgraded: 0x4ade80, problems: 0xfbbf24, error: 0xf87171 };
const MAX_LINES = 20;

const post = async (url, body, headers = {}) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
};

// "series" is its own plural.
const plural = (n, word) => `${n} ${word}${n === 1 || word.endsWith('s') ? '' : 's'}`;

const clip = (lines) => lines.slice(0, MAX_LINES).join('\n') + (lines.length > MAX_LINES ? `\n…and ${lines.length - MAX_LINES} more` : '');

/**
 * Builds the message for an event:
 *  { kind: 'upgraded', series: [{ title, files }] }                 subbed files replaced by dual audio
 *  { kind: 'problems', series: [{ title, noJapanese, noSubs }] }    new files breaking the rules
 *  { kind: 'replaced', files: [{ title, file, release, blocklisted }] }   deleted, searching again
 *  { kind: 'error', error }
 *  { kind: 'test' }
 */
export function message(evt) {
  if (evt.kind === 'test') return { title: 'Dualarr test', text: 'Notifications are working.' };
  if (evt.kind === 'error') return { title: 'Dualarr: scan failed', text: evt.error, color: COLOR.error };
  if (evt.kind === 'upgraded') {
    const files = evt.series.reduce((n, s) => n + s.files, 0);
    return {
      title: `Dual audio: ${plural(files, 'file')} upgraded`,
      text: clip(evt.series.map((s) => `${s.title} (${plural(s.files, 'file')})`)),
      color: COLOR.upgraded,
    };
  }
  if (evt.kind === 'replaced') {
    return {
      title: `Dualarr: replaced ${plural(evt.files.length, 'file')} without Japanese audio`,
      text: clip(evt.files.map((f) => `${f.title}: ${f.file.split('/').pop()}${f.blocklisted ? ` (${f.release} blocklisted)` : ''}`)),
      color: COLOR.problems,
    };
  }
  const why = (s) => [s.noJapanese && `${s.noJapanese} without Japanese audio`, s.noSubs && `${s.noSubs} without subtitles`].filter(Boolean).join(', ');
  return {
    title: `Dualarr: ${plural(evt.series.length, 'series')} need${evt.series.length === 1 ? 's' : ''} attention`,
    text: clip(evt.series.map((s) => `${s.title}: ${why(s)}`)),
    color: COLOR.problems,
  };
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** The HTTP request each notifier type makes (exported so it can be tested without sending). */
export function request(n, evt) {
  const m = message(evt);
  switch (n.type) {
    case 'discord':
      return { url: n.webhookUrl, body: { username: 'Dualarr', embeds: [{ title: m.title, description: m.text.slice(0, 4000), color: m.color }] } };
    case 'telegram':
      return {
        url: `https://api.telegram.org/bot${n.botToken}/sendMessage`,
        body: { chat_id: n.chatId, text: `<b>${esc(m.title)}</b>\n${esc(m.text)}`.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true },
      };
    case 'ntfy':
      return {
        url: `${(n.server || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(n.topic)}`,
        raw: m.text || m.title,
        headers: {
          'Content-Type': 'text/plain',
          // ntfy headers must be ASCII; the title goes in the body when it isn't.
          ...(/^[\x20-\x7e]*$/.test(m.title) ? { Title: m.title } : {}),
          Tags: evt.kind === 'upgraded' ? 'tada' : evt.kind === 'test' ? 'tv' : 'warning',
          ...(n.token ? { Authorization: `Bearer ${n.token}` } : {}),
        },
      };
    case 'gotify':
      return {
        url: `${(n.server || '').replace(/\/+$/, '')}/message?token=${encodeURIComponent(n.token)}`,
        body: { title: m.title, message: m.text || m.title, priority: evt.kind === 'upgraded' || evt.kind === 'test' ? 4 : 7 },
      };
    case 'webhook':
      return { url: n.url, body: { event: evt.kind, title: m.title, ...evt } };
    default:
      throw new Error(`Unknown notifier type ${n.type}`);
  }
}

export async function send(n, evt) {
  const r = request(n, evt);
  if (!r.url || /undefined|null/.test(r.url)) throw new Error('Notifier is missing its URL or token');
  if (r.raw !== undefined) {
    const res = await fetch(r.url, { method: 'POST', headers: r.headers, body: r.raw, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return;
  }
  await post(r.url, r.body, r.headers);
}

/** Sends to every enabled notifier; failures are logged and returned, never thrown. */
export async function notifyAll(notifiers, evt) {
  const failures = [];
  for (const n of notifiers.filter((x) => x.enabled !== false)) {
    try {
      await send(n, evt);
    } catch (e) {
      failures.push(`${n.name || NOTIFIER_TYPES[n.type]?.label}: ${e.message}`);
      log(`Notification via ${n.type} failed: ${e.message}`);
    }
  }
  return failures;
}
