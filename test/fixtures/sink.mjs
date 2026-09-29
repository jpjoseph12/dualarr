// A webhook receiver for notification tests: records every request it gets.
// `fail = true` makes it answer 500.
import http from 'node:http';

export function startSink() {
  const sink = { received: [], fail: false };
  sink.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      let parsed = body;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* plain text (ntfy) */
      }
      sink.received.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
      res.writeHead(sink.fail ? 500 : 200, { 'Content-Type': 'application/json', Connection: 'close' }); // see mock-sonarr.mjs
      res.end(sink.fail ? '{"error":"nope"}' : '{"ok":true}');
    });
  });
  return new Promise((r) =>
    sink.server.listen(0, () => {
      sink.url = `http://127.0.0.1:${sink.server.address().port}`;
      r(sink);
    }),
  );
}
