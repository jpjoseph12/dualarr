import { Cron } from 'croner';
import { TZ, log } from './config.js';
import { scanJob } from './jobs.js';

let job = null;

export function validateCron(expr) {
  try {
    new Cron(expr, { paused: true, timezone: TZ }).stop();
    return null;
  } catch (e) {
    return e.message;
  }
}

export function schedule(expr) {
  job?.stop();
  job = null;
  if (!expr) {
    log('Scheduled scan disabled');
    return;
  }
  // unref: the timer alone never keeps the process alive (matters for tests).
  job = new Cron(expr, { timezone: TZ, protect: true, unref: true }, () => {
    scanJob('schedule', { autoSearch: true }).catch((e) => log(`Scheduled scan failed: ${e.message}`));
  });
  log(`Scheduled scan "${expr}" (${TZ}), next at ${job.nextRun()?.toISOString()}`);
}

export const nextRun = () => job?.nextRun()?.toISOString() ?? null;
