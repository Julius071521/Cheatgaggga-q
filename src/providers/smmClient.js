'use strict';
// Generic client for the standard SMM Panel API v2.
// All actions are form-encoded POSTs: { key, action, ...params }

class SmmClient {
  constructor({ code, name, url, key, timeoutMs = 30000 }) {
    this.code = code;
    this.name = name;
    this.url = url;
    this.key = key;
    this.timeoutMs = timeoutMs;
  }

  async call(params) {
    const body = new URLSearchParams({ key: this.key, ...params });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch (_) {
        throw new Error(`Provider ${this.code} returned non-JSON response (HTTP ${res.status})`);
      }
      if (json && typeof json === 'object' && !Array.isArray(json) && json.error) {
        throw new Error(`Provider ${this.code}: ${String(json.error).slice(0, 200)}`);
      }
      return json;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Provider ${this.code}: request timed out`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  services() {
    return this.call({ action: 'services' });
  }

  addOrder({ service, link, quantity, runs, interval }) {
    const params = { action: 'add', service, link, quantity };
    // Drip-feed: split the delivery into `runs` batches every `interval` minutes.
    if (runs && interval) { params.runs = runs; params.interval = interval; }
    return this.call(params);
  }

  orderStatus(providerOrderId) {
    return this.call({ action: 'status', order: providerOrderId });
  }

  multiStatus(providerOrderIds) {
    return this.call({ action: 'status', orders: providerOrderIds.join(',') });
  }

  balance() {
    return this.call({ action: 'balance' });
  }

  refill(providerOrderId) {
    return this.call({ action: 'refill', order: providerOrderId });
  }

  // Check how a previously-requested refill is doing at the provider.
  // Standard SMM v2: { action: 'refill_status', refill: <id> } → { status: 'Completed'|'Pending'|... }
  refillStatus(refillId) {
    return this.call({ action: 'refill_status', refill: String(refillId) });
  }

  cancel(providerOrderId) {
    // Standard SMM v2 uses "orders" (comma list) for cancel.
    return this.call({ action: 'cancel', orders: String(providerOrderId) });
  }
}

module.exports = SmmClient;
