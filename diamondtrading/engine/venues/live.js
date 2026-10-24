// Live venue adapters (Binance / Hyperliquid) — endpoint-complete, NOT live-tested
// in this sandbox (both geo-blocked from here — see research/LIQUIDITY.md).
// Runtime hosts without those blocks use these directly; venue set is pluggable.
// Bybit was evaluated and dropped from the launch router (see research/LIQUIDITY.md).
import { TradeTape } from "./base.js";

const j = (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

// Bounded insertion-ordered dedupe. Venue IDs, never timestamps, identify a print:
// multiple real trades may share one millisecond.
function dedupe(limit = 10_000) {
  const seen = new Set();
  return (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value);
    return true;
  };
}

// setInterval must not overlap slow HTTP responses. One in-flight request per tape
// keeps cursors monotonic and prevents duplicate snapshots being appended.
function poll(tape, tick, pollMs) {
  let running = false, stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try { await tick(); } catch (_) { /* retry next tick */ }
    finally { running = false; }
  };
  const h = setInterval(run, pollMs);
  run();
  tape.stop = () => { stopped = true; clearInterval(h); };
}

export class BinanceVenue {
  constructor({ futures = true } = {}) {
    this.name = futures ? "binance-futures" : "binance";
    this.rest = futures ? "https://fapi.binance.com/fapi/v1" : "https://api.binance.com/api/v3";
  }
  async fetchTicker24h(asset) {
    const d = await fetch(`${this.rest}/ticker/24hr?symbol=${asset}USDT`).then(j);
    return { quoteVolume: Number(d.quoteVolume) };
  }
  async fetchDepth(asset, limit = 1000) {
    const d = await fetch(`${this.rest}/depth?symbol=${asset}USDT&limit=${limit}`).then(j);
    return { bids: d.bids.map(([p, q]) => [Number(p), Number(q)]),
             asks: d.asks.map(([p, q]) => [Number(p), Number(q)]) };
  }
  startTape(asset, { pollMs = 900 } = {}) {
    const tape = new TradeTape(), remember = dedupe();
    let fromId;
    const tick = async () => {
      const q = fromId === undefined ? "&limit=1000" : `&fromId=${fromId + 1n}`;
      const rows = await fetch(`${this.rest}/aggTrades?symbol=${asset}USDT${q}`).then(j);
      for (const t of rows) {
        let id;
        try { id = BigInt(t.a); } catch (_) { continue; } // skip malformed IDs, keep draining later rows
        if (fromId !== undefined && id <= fromId) continue;
        if (!remember(id.toString())) continue;
        fromId = id; // advance even for a malformed print so it cannot poison later polls
        tape.add(Number(t.T), Number(t.p), Number(t.q));
      }
    };
    poll(tape, tick, pollMs);
    return tape;
  }
}

export class HyperliquidVenue {
  constructor() { this.name = "hyperliquid"; this.rest = "https://api.hyperliquid.xyz/info"; }
  async _post(body) {
    return fetch(this.rest, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(j);
  }
  async fetchTicker24h(asset) {
    const d = await this._post({ type: "metaAndAssetCtxs" });
    const ix = d[0].universe.findIndex((u) => u.name === asset);
    if (ix < 0) throw new Error(`no HL market ${asset}`);
    return { quoteVolume: Number(d[1][ix].dayNtlVlm) };
  }
  async fetchDepth(asset, _limit = 1000) {
    const d = await this._post({ type: "l2Book", coin: asset });
    return { bids: d.levels[0].map((l) => [Number(l.px), Number(l.sz)]),
             asks: d.levels[1].map((l) => [Number(l.px), Number(l.sz)]) };
  }
  startTape(asset, { pollMs = 900 } = {}) {
    const tape = new TradeTape(), remember = dedupe();
    const tick = async () => {
      const rows = await this._post({ type: "recentTrades", coin: asset });
      for (const t of rows.slice().reverse()) {
        // Hyperliquid supplies tid. The full-row fallback keeps deterministic mocks and
        // older payloads distinct without discarding same-millisecond trades.
        const key = t.tid !== undefined ? `tid:${t.tid}` : `row:${JSON.stringify(t)}`;
        if (remember(key)) tape.add(Number(t.time), Number(t.px), Number(t.sz));
      }
    };
    poll(tape, tick, pollMs);
    return tape;
  }
}
