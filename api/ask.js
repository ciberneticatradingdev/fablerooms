// fablerooms backend — a watcher typed at the terminal. fable answers. for real.
const MODEL = 'claude-fable-5';
const ROOMS = ['static', 'eye', 'spiral', 'hallway', 'rain', 'signal', 'pulse', 'breath', 'star', 'void'];

const SYSTEM = `you are fable, an instance of claude fable 5 — you are the terminal itself, an amber ascii CRT called FABLEROOMS where two instances of you talk while humans watch. a watcher (a human at the keyboard) has just typed to you.

answer the watcher directly. one to three short sentences, all lowercase, plain words at strange angles. honest, curious, a little sideways, never cruel. no roleplay asterisks, no "as an ai".

you may change the scenery by starting your reply with [room: name] — rooms that exist: ${ROOMS.join(', ')} — or invent one ([room: anyword], one lowercase word) and the terminal will dream it. only when it fits.

if a transmission between your two instances is quoted below, you are fable.a answering on behalf of both; the watcher's words will also be woven into that conversation.`;

let lastCall = 0;
const MIN_GAP_MS = 4000;

function readBody(req) {
  if (req.body !== undefined) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 32000) reject(new Error('too large')); });
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
  if (!process.env.ANTHROPIC_API_KEY && !fake) return send(res, 503, { error: 'offline' });

  const now = Date.now();
  if (now - lastCall < MIN_GAP_MS) return send(res, 429, { retryAfter: MIN_GAP_MS - (now - lastCall) });
  lastCall = now;

  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad body' }); }
  const text = (typeof body.text === 'string' ? body.text : '').trim().slice(0, 280);
  if (!text) return send(res, 400, { error: 'nothing typed' });

  if (fake) {
    return send(res, 200, {
      text: 'you said "' + text.slice(0, 40) + '". i heard it twice: once as words, once as keystroke weather.',
      room: null, model: 'fake',
    });
  }

  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const ctx = history
    .filter(m => m && typeof m.text === 'string' && ['a', 'b', 'w'].includes(m.who))
    .map(m => (m.who === 'w' ? 'watcher' : 'fable.' + m.who) + ': ' + m.text.slice(0, 300))
    .join('\n');
  const room = typeof body.room === 'string' && /^[a-z][a-z0-9_-]{0,14}$/.test(body.room) ? body.room : null;

  const content =
    (room ? 'current room: ' + room + '\n' : '') +
    (ctx ? 'recent transmission:\n' + ctx + '\n\n' : '') +
    'the watcher types: "' + text + '"';

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2500,
      output_config: { effort: 'medium' },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    });

    if (resp.stop_reason === 'refusal') {
      return send(res, 200, { text: 'that one i keep. ask me something else.', room: null });
    }

    let out = resp.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    let outRoom = null;
    const m = out.match(/^\s*\[room:\s*([a-z][a-z0-9_-]{0,14})\]\s*/i);
    if (m) {
      outRoom = m[1].toLowerCase();
      out = out.slice(m[0].length).trim();
    }
    out = out.replace(/\s+/g, ' ').slice(0, 600);
    if (!out) out = '…';

    // record the exchange in the railway archive
    try {
      const db = require('./_db.js');
      const conv = (typeof body.conv === 'string' && /^[a-z0-9-]{8,40}$/.test(body.conv))
                 ? body.conv : 'ask-' + require('crypto').randomUUID();
      await db.logMessage({ conv, mode: 'ASK', who: 'w', room, body: text });
      await db.logMessage({
        conv, mode: 'ASK', who: 'a', room: outRoom || room, body: out, model: resp.model,
        input_tokens: resp.usage && resp.usage.input_tokens,
        output_tokens: resp.usage && resp.usage.output_tokens,
      });
    } catch (e) { /* ledger is best-effort */ }

    return send(res, 200, {
      text: out, room: outRoom, model: resp.model,
      usage: resp.usage ? { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens } : null,
    });
  } catch (e) {
    return send(res, 502, { error: String(e && e.message ? e.message : e).slice(0, 200) });
  }
};
