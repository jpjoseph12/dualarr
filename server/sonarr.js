// Minimal Sonarr v4 API client: the series and files to check, the custom formats and quality
// profiles that make Sonarr prefer dual audio, and the commands that search for replacements.

export function sonarrClient(settings) {
  const base = (settings.sonarrUrl || '').trim().replace(/\/+$/, '');
  const apiKey = (settings.sonarrApiKey || '').trim();
  if (!base || !apiKey) return null;

  async function req(p, init = {}) {
    const res = await fetch(`${base}/api/v3${p}`, {
      ...init,
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Sonarr ${p.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  const send = (method, p, body) => req(p, { method, body: body === undefined ? undefined : JSON.stringify(body) });

  return {
    base,
    status: () => req('/system/status'),
    series: () => req('/series'),
    seriesById: (id) => req(`/series/${id}`),
    episodeFiles: (seriesId) => req(`/episodefile?seriesId=${seriesId}`),
    episodes: (seriesId) => req(`/episode?seriesId=${seriesId}`),
    seriesHistory: (seriesId) => req(`/history/series?seriesId=${seriesId}`),
    /** Marks a grab as failed: Sonarr blocklists that release so it isn't grabbed again. */
    markFailed: (historyId) => send('POST', `/history/failed/${historyId}`),
    deleteEpisodeFile: (id) => send('DELETE', `/episodefile/${id}`),
    command: (body) => send('POST', '/command', body),

    customFormats: () => req('/customformat'),
    saveCustomFormat: (cf) => (cf.id ? send('PUT', `/customformat/${cf.id}`, cf) : send('POST', '/customformat', cf)),
    qualityProfiles: () => req('/qualityprofile'),
    qualityProfile: (id) => req(`/qualityprofile/${id}`),
    saveQualityProfile: (p) => send('PUT', `/qualityprofile/${p.id}`, p),
  };
}
