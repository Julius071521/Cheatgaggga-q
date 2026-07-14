'use strict';
// Cron entry point: refresh the service catalog from every configured provider.
// Suggested schedule: daily. Example crontab:
//   0 3 * * * cd /path/to/app && /usr/bin/node src/jobs/syncServices.js >> logs/sync.log 2>&1
const { syncProvider } = require('../services/catalog');
const { allClients } = require('../providers');

async function run() {
  const clients = allClients();
  if (!clients.length) {
    console.log('[syncServices] No providers configured — nothing to do.');
    return;
  }
  for (const client of clients) {
    try {
      const result = await syncProvider(client.code);
      console.log(`[syncServices] ${result.provider}: imported ${result.imported} of ${result.totalFromProvider}`);
    } catch (err) {
      console.error(`[syncServices] ${client.code} failed: ${err.message}`);
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
