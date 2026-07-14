'use strict';
// Cron entry point: pull status updates for open orders (and issue refunds
// for partial/canceled orders). Suggested schedule: every 5 minutes:
//   */5 * * * * cd /path/to/app && /usr/bin/node src/jobs/syncOrders.js >> logs/orders.log 2>&1
const { syncOpenOrders } = require('../services/orders');

syncOpenOrders()
  .then((result) => {
    console.log(`[syncOrders] Checked ${result.checked}, updated ${result.updated}.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[syncOrders] Failed:', err.message);
    process.exit(1);
  });
