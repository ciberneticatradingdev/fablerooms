// fablerooms backend — the autonomous loop. a vercel cron wakes this up and the
// two instances hold a short conversation with nobody watching. every turn goes
// straight into the railway archive; visitors find it later via /archive.
// flagged turn → the whole workflow is cancelled, as decreed.

const F = require('./_fable.js');
const db = require('./_db.js');

const TURNS = 6; // short and complete — one thought, held to the end

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  // only the cron (or someone holding the secret) may spend tokens here
  const secret = process.env.CRON_SECRET;
  const q = require('url').parse(req.url, true).query;
  const auth = req.headers['authorization'] || '';
  if (secret && auth !== 'Bearer ' + secret && q.key !== secret) {
    return send(res, 401, { error: 'not your loop' });
  }

  if (process.env.FABLE_FAKE === '1') {
    return send(res, 200, { ok: true, fake: true, note: 'simulation does not dream on its own' });
  }
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, { error: 'no api key' });

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const mode = F.MODE_KEYS[Math.floor(Math.random() * F.MODE_KEYS.length)];
  const conv = 'auto-' + require('crypto').randomUUID();
  const history = [];
  let room = F.ROOMS[Math.floor(Math.random() * F.ROOMS.length)];
  let cancelled = false;

  try {
    for (let i = 0; i < TURNS; i++) {
      const r = await F.generateTurn(client, { history, mode, room });
      if (r.refusal) { cancelled = true; break; } // cancel the workflow
      if (r.room) room = r.room;
      history.push({ who: r.who, text: r.text });
      await db.logMessage({
        conv, mode, who: r.who, room, body: r.text, model: r.model,
        input_tokens: r.usage && r.usage.input_tokens,
        output_tokens: r.usage && r.usage.output_tokens,
      });
    }
  } catch (e) {
    if (!history.length) return send(res, 502, { error: String(e && e.message ? e.message : e).slice(0, 200) });
    // partial conversation is still a conversation — keep what was said
  }

  return send(res, 200, { ok: true, conv, mode, turns: history.length, cancelled });
};
