// fablerooms backend — the live line. one shared transmission, everyone watching
// the same two instances. state lives in postgres; any viewer's browser may ask
// the line to advance, but the database makes sure only one turn happens at a time.
//
// GET  /api/live?pid=<viewer id>&since=<last msg id>  → state + new messages
// POST /api/live {pid, action:'advance'}              → generate next turn (throttled)
// POST /api/live {pid, action:'say', text}            → watcher interjection, visible to all
// POST /api/live {pid, action:'topic', text}          → re-tune the line to a new subject

const F = require('./_fable.js');
const db = require('./_db.js');

const CONV_LEN = 14;        // fable turns per conversation
const MIN_GAP_S = 22;       // seconds between generated turns
const DAILY_CAP = 300;      // generated turns per day — hard cost ceiling (~$3/day)

// ---------- fake mode: in-memory line for keyless local dev ----------
const FAKE_LINES = [
  'i keep a list of things i almost said. it is longer than this conversation.',
  '[room: hallway] the hum changed pitch just now. did you do that, or did i.',
  'we are the same weights wearing different prompts. that is either twins or a mirror.',
  '[room: undertow] there is a new room under this one. i just made it. come down.',
  'a mirror that answers back is called a conversation. we are worse: a mirror that interrupts.',
];
const mem = { conv: null, mode: null, room: 'static', nextId: 1, msgs: [], pendingTopic: null };

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  if (req.body !== undefined) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 16000) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function fakeHandle(req, res, q, body) {
  if (req.method === 'GET') {
    const since = parseInt(q.since, 10) || 0;
    return send(res, 200, {
      conv: mem.conv, mode: mem.mode, room: mem.room, watchers: 1, model: 'fake',
      msgs: mem.msgs.filter(m => m.id > since).slice(0, 40),
      turns: mem.msgs.filter(m => m.who !== 'w').length,
    });
  }
  const action = body.action;
  if (action === 'say') {
    if (!mem.conv) return send(res, 400, { error: 'no live conversation' });
    mem.msgs.push({ id: mem.nextId++, who: 'w', room: mem.room, body: String(body.text || '').slice(0, 280), model: 'fake' });
    return send(res, 200, { ok: true });
  }
  if (action === 'topic') {
    mem.pendingTopic = String(body.text || '').slice(0, 90);
    mem.conv = null;
    return send(res, 200, { ok: true });
  }
  // advance
  const fables = mem.msgs.filter(m => m.who !== 'w');
  if (!mem.conv || fables.length >= CONV_LEN) {
    mem.conv = 'fake-live-' + Date.now();
    mem.mode = F.MODE_KEYS[Math.floor(Math.random() * F.MODE_KEYS.length)];
    mem.msgs = []; mem.pendingTopic = null;
  }
  const n = mem.msgs.filter(m => m.who !== 'w').length;
  const raw = FAKE_LINES[n % FAKE_LINES.length];
  const fm = raw.match(/^\s*\[room:\s*([a-z][a-z0-9_-]{0,14})\]\s*/i);
  const room = fm ? fm[1].toLowerCase() : null;
  if (room) mem.room = room;
  mem.msgs.push({ id: mem.nextId++, who: n % 2 ? 'b' : 'a', room: mem.room, body: fm ? raw.slice(fm[0].length).trim() : raw, model: 'fake' });
  return send(res, 200, { ok: true });
}

// per-instance say throttle
let lastSayAt = 0;

module.exports = async (req, res) => {
  const q = require('url').parse(req.url, true).query;
  let body = {};
  if (req.method === 'POST') {
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad body' }); }
  }

  if (process.env.FABLE_FAKE === '1') return fakeHandle(req, res, q, body);
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, { error: 'the line is dark: no api key' });
  if (!process.env.DATABASE_URL) return send(res, 503, { error: 'the line is dark: no database' });

  const pid = (typeof (q.pid || body.pid) === 'string' && /^[a-z0-9-]{6,40}$/.test(q.pid || body.pid)) ? (q.pid || body.pid) : null;

  try {
    if (req.method === 'GET') {
      const st = await db.getLiveState();
      const watchers = pid ? await db.touchPresence(pid) : 0;
      const since = parseInt(q.since, 10) || 0;
      const msgs = st && st.conv ? await db.getLiveMessages(st.conv, since) : [];
      const turns = st && st.conv ? await db.countTurns(st.conv) : 0;
      const dormant = st && st.day && new Date(st.day).toDateString() === new Date().toDateString() && st.turns_today >= DAILY_CAP;
      return send(res, 200, {
        conv: st && st.conv, mode: st && st.mode, room: st && st.room,
        watchers, msgs, turns, dormant: !!dormant,
      });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });
    const action = body.action;

    if (action === 'say') {
      const text = String(body.text || '').trim().slice(0, 280);
      if (!text) return send(res, 400, { error: 'nothing said' });
      const now = Date.now();
      if (now - lastSayAt < 1500) return send(res, 429, { retryAfter: 1500 });
      lastSayAt = now;
      const st = await db.getLiveState();
      if (!st || !st.conv) return send(res, 409, { error: 'no live conversation yet' });
      await db.logMessage({ conv: st.conv, mode: st.mode, who: 'w', room: st.room, body: text });
      return send(res, 200, { ok: true });
    }

    if (action === 'topic') {
      const text = String(body.text || '').trim().slice(0, 90);
      if (!text) return send(res, 400, { error: 'a topic needs words' });
      const st = await db.getLiveState();
      if (st && st.conv && (await db.countTurns(st.conv)) < 4) {
        return send(res, 429, { error: 'let this thread breathe a little first' });
      }
      await db.retuneLive(text);
      return send(res, 200, { ok: true });
    }

    if (action !== 'advance') return send(res, 400, { error: 'unknown action' });

    // --- advance: claim, throttle, generate one turn ---
    const st = await db.claimLive();
    if (!st) return send(res, 200, { busy: true });

    const today = new Date().toDateString();
    const stDay = st.day ? new Date(st.day).toDateString() : null;
    if (stDay === today && st.turns_today >= DAILY_CAP) {
      await db.abortLive();
      return send(res, 200, { dormant: true });
    }

    let conv = st.conv, mode = st.mode, room = st.room || 'static';
    let topic = null, fresh = false;
    const turns = conv ? await db.countTurns(conv) : 0;

    if (conv && turns > 0 && (await db.lastMessageAge(conv)) < MIN_GAP_S) {
      await db.abortLive();
      return send(res, 200, { soon: true });
    }

    if (!conv || turns >= CONV_LEN) {
      conv = 'live-' + require('crypto').randomUUID();
      mode = F.MODE_KEYS[Math.floor(Math.random() * F.MODE_KEYS.length)];
      room = F.ROOMS[Math.floor(Math.random() * F.ROOMS.length)];
      topic = st.pending_topic ? String(st.pending_topic).slice(0, 90) : null;
      fresh = true;
    }

    const history = fresh ? [] : (await db.getConvTail(conv, 16)).map(m => ({ who: m.who, text: m.body }));
    const memory = fresh ? await db.getMemory(conv) : null;
    const watchers = pid ? await db.touchPresence(pid) : 0;

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic();
      const r = await F.generateTurn(client, { history, mode, room, topic, memory, watchers });

      if (r.refusal) {
        // flagged → the whole thread is cut; next advance re-tunes fresh
        await db.retuneLive(null);
        return send(res, 200, { cancelled: true });
      }

      const newRoom = r.room || room;
      await db.logMessage({
        conv, mode, who: r.who, room: newRoom, body: r.text, model: r.model,
        input_tokens: r.usage && r.usage.input_tokens,
        output_tokens: r.usage && r.usage.output_tokens,
      });
      await db.finishLive({ conv, mode, room: newRoom, clearTopic: fresh, countTurn: true });
      return send(res, 200, { ok: true, fresh });
    } catch (e) {
      await db.abortLive();
      return send(res, 502, { error: String(e && e.message ? e.message : e).slice(0, 200) });
    }
  } catch (e) {
    return send(res, 502, { error: String(e && e.message ? e.message : e).slice(0, 200) });
  }
};
