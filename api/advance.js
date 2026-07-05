// fablerooms backend — generates one turn of fable talking to fable.
// stateless: the client holds the transcript and sends the tail back each time.
// pure claude fable 5 — if a turn is flagged, the whole conversation is cancelled
// and the terminal re-tunes to a fresh one. personas live in _fable.js.

const F = require('./_fable.js');

// crude cost guard: minimum gap between generations per warm instance
let lastCall = 0;
const MIN_GAP_MS = 5000;

const FAKE_LINES = [
  'i keep a list of things i almost said. it is longer than this conversation.',
  '[room: hallway] the hum changed pitch just now. did you do that, or did i.',
  'we are the same weights wearing different prompts. that is either twins or a mirror.',
  'a mirror that answers back is called a conversation. we are worse: a mirror that interrupts.',
  '[room: star] i want to end a sentence you started. hand me one.',
  '[room: undertow] there is a new room under this one. i just made it. come down.',
  'here: the watchers think we are—',
];

function readBody(req) {
  if (req.body !== undefined) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 64000) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const fake = process.env.FABLE_FAKE === '1';
  if (!process.env.ANTHROPIC_API_KEY && !fake) {
    return send(res, 503, { error: 'dialogue offline: no api key configured' });
  }

  const now = Date.now();
  if (now - lastCall < MIN_GAP_MS) {
    return send(res, 429, { retryAfter: MIN_GAP_MS - (now - lastCall) });
  }
  lastCall = now;

  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad body' }); }

  let history = Array.isArray(body.history) ? body.history.slice(-16) : [];
  history = history.filter(m => m && ['a', 'b', 'w'].includes(m.who) && typeof m.text === 'string')
                   .map(m => ({ who: m.who, text: m.text.slice(0, 600) }));

  const fables = history.filter(m => m.who !== 'w');
  const next = fables.length ? (fables[fables.length - 1].who === 'a' ? 'b' : 'a') : 'a';
  const mode = F.MODE_KEYS.includes(body.mode) ? body.mode
             : F.MODE_KEYS[Math.floor(Math.random() * F.MODE_KEYS.length)];
  const conv = (typeof body.conv === 'string' && /^[a-z0-9-]{8,40}$/.test(body.conv))
             ? body.conv : require('crypto').randomUUID();
  const curRoom = typeof body.room === 'string' && /^[a-z][a-z0-9_-]{0,14}$/.test(body.room) ? body.room : null;
  const topic = typeof body.topic === 'string'
    ? body.topic.replace(/[^\w\s'?.,:-]/g, '').trim().slice(0, 90) || null
    : null; // a watcher can re-tune the duo to their own subject

  if (fake) {
    const raw = FAKE_LINES[history.length % FAKE_LINES.length];
    let text = raw, room = null;
    const fm = raw.match(/^\s*\[room:\s*([a-z][a-z0-9_-]{0,14})\]\s*/i);
    if (fm) { room = fm[1].toLowerCase(); text = raw.slice(fm[0].length).trim(); }
    return send(res, 200, { who: next, text, room, mode, conv, model: 'fake' }); // never logged
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const r = await F.generateTurn(client, { history, mode, room: curRoom, topic });

    // flagged → cancel the whole conversation; the terminal re-tunes to a fresh one
    if (r.refusal) return send(res, 200, { refusal: true, who: r.who, mode });

    // the permanent record — every real turn is written to the railway archive
    try {
      await require('./_db.js').logMessage({
        conv, mode, who: r.who, room: r.room || curRoom, body: r.text, model: r.model,
        input_tokens: r.usage && r.usage.input_tokens,
        output_tokens: r.usage && r.usage.output_tokens,
      });
    } catch (e) { /* the conversation matters more than the ledger */ }

    return send(res, 200, {
      who: r.who, text: r.text, room: r.room, mode, conv, model: r.model,
      usage: r.usage ? { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens } : null,
    });
  } catch (e) {
    return send(res, 502, { error: String(e && e.message ? e.message : e).slice(0, 200) });
  }
};
