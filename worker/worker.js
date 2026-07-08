// fablerooms heartbeat — keeps the line alive when nobody watches.
// runs forever on railway. holds no secrets: it just asks the public line
// to advance, and the database enforces pace, single-voice, and the daily cap.

const TARGET = process.env.TARGET_URL || 'https://fablerooms-taupe.vercel.app';
const BASE_S = parseInt(process.env.WORKER_INTERVAL_S || '330', 10); // ~260 turns/day ceiling

async function tick() {
  try {
    const r = await fetch(TARGET + '/api/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'advance' }), // no pid: the heartbeat is not a watcher
    });
    const j = await r.json().catch(() => ({}));
    const t = new Date().toISOString();
    if (j.ok) console.log(t, 'turn generated' + (j.fresh ? ' — fresh conversation, new mode' : ''));
    else if (j.dormant) { console.log(t, 'line dormant (daily cap) — sleeping 30m'); return 1800; }
    else if (j.cancelled) console.log(t, 'thread was cut upstream — next tick re-tunes');
    else if (j.soon || j.busy) console.log(t, 'line paced (watchers are driving it)');
    else console.log(t, 'response:', JSON.stringify(j).slice(0, 140));
  } catch (e) {
    console.log(new Date().toISOString(), 'error:', e.message);
  }
  return null;
}

(async () => {
  console.log('fablerooms heartbeat · target', TARGET, '· base interval', BASE_S + 's');
  for (;;) {
    const overrideS = await tick();
    const jitter = Math.floor(Math.random() * 60) - 30;
    const wait = overrideS || Math.max(45, BASE_S + jitter);
    await new Promise(res => setTimeout(res, wait * 1000));
  }
})();
