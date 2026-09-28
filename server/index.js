import { PORT, TZ, VERSION, log } from './config.js';
import * as store from './db.js';
import { app } from './app.js';
import { schedule } from './scheduler.js';
import { ensureKeys, isConfigured, resetAccount } from './auth.js';

// Forgot the password? Start once with DUALARR_RESET_AUTH=true, then remove it again.
if (/^(1|true|yes)$/i.test(process.env.DUALARR_RESET_AUTH || '')) {
  resetAccount();
  log('DUALARR_RESET_AUTH is set: the login was removed — open the web UI to create a new one, then remove the variable');
}
ensureKeys();
if (!isConfigured()) log('No login yet — open the web UI to create one');

app.listen(PORT, () => log(`Dualarr ${VERSION} listening on :${PORT} (TZ ${TZ})`));
schedule(store.getSettings().schedule);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    process.exit(0);
  });
}
