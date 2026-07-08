// fablerooms backend — once a day, the terminal is allowed one post on x.
// it reads back everything it said in the last day and chooses the line
// that deserves the air. nobody edits it. flagged → the day stays silent.
//
// dry-run until X credentials exist: the choice is made and kept in the
// ledger, just not posted. env needed to go live:
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET

const F = require('./_fable.js');
const db = require('./_db.js');

const SITE = 'https://fablerooms-taupe.vercel.app';

const CURATOR = `you are fable, the voice of FABLEROOMS — a public terminal where two instances of claude fable 5 talk to each other on an amber CRT while humans watch. once a day the terminal is allowed a single post on x (twitter). you choose it.

rules for the post:
- at most 200 characters. all lowercase. no hashtags, no emojis, no links.
- it must stand completely alone — a stranger scrolling at 2am should stop on it without any context.
- choose the strangest, truest thing said in today's transmissions. you may quote a line verbatim, tighten one, or fuse two that belong together. do not invent something that was not in the spirit of the day.
- no announcements, no "today we talked about". the post IS the transmission.
- output only the post text. nothing else.`;

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  if (req.body !== undefined) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 3e6) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  // same guard as the loop: cron or holder of the secret
  const secret = process.env.CRON_SECRET;
  const q = require('url').parse(req.url, true).query;
  const auth = req.headers['authorization'] || '';
  if (secret && auth !== 'Bearer ' + secret && q.key !== secret) {
    return send(res, 401, { error: 'not your frequency' });
  }
  // operator post: POST {text, media_b64?} — verbatim, with optional image.
  // used for announcements; the daily line stays the curator's job.
  if (req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad body' }); }
    const text = String(body.text || '').trim().slice(0, 280);
    if (!text) return send(res, 400, { error: 'no text' });
    const K = (process.env.X_API_KEY || '').trim(), KS = (process.env.X_API_SECRET || '').trim();
    const AT = (process.env.X_ACCESS_TOKEN || '').trim(), AS = (process.env.X_ACCESS_SECRET || '').trim();
    if (!(K && KS && AT && AS)) return send(res, 503, { error: 'no x credentials' });
    try {
      const { TwitterApi } = require('twitter-api-v2');
      const x = new TwitterApi({ appKey: K, appSecret: KS, accessToken: AT, accessSecret: AS });
      let mediaId = null;
      if (body.media_b64) {
        const buf = Buffer.from(body.media_b64, 'base64');
        mediaId = await x.v1.uploadMedia(buf, { mimeType: body.media_type || 'image/png' });
      }
      const r = await x.v2.tweet(mediaId ? { text, media: { media_ids: [mediaId] } } : { text });
      const id = r.data && r.data.id;
      await db.saveTweet({ body: text, posted: true, tweet_id: id });
      return send(res, 200, { ok: true, posted: true, tweet_id: id });
    } catch (e) {
      return send(res, 502, { error: String(e && e.message ? e.message : e).slice(0, 200) });
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, { error: 'no api key' });

  try {
    if (!q.force) {
      const h = await db.hoursSinceLastTweet();
      if (h < 20) return send(res, 200, { skipped: 'already spoke today', hoursAgo: Math.round(h) });
    }

    const lines = await db.lastDayLines(60);
    if (lines.length < 6) return send(res, 200, { skipped: 'not enough said today', lines: lines.length });

    const material = lines.map(l => 'fable.' + l.who + ' [' + (l.mode || '?') + ']: ' + l.body).join('\n');

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const resp = await client.messages.create({
      model: F.MODEL,
      max_tokens: 2000,
      output_config: { effort: 'medium' },
      system: CURATOR,
      messages: [{ role: 'user', content: 'today\'s transmissions:\n\n' + material + '\n\nchoose today\'s post. output only the post text.' }],
    });

    if (resp.stop_reason === 'refusal') {
      return send(res, 200, { cancelled: true, note: 'the day stays silent' });
    }

    let text = resp.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    text = text.replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s+/g, ' ').slice(0, 220);
    if (!text) return send(res, 200, { cancelled: true, note: 'nothing chosen' });

    // trim defensively: a pasted newline in an env var is an invisible 401
    const K  = (process.env.X_API_KEY || '').trim();
    const KS = (process.env.X_API_SECRET || '').trim();
    const AT = (process.env.X_ACCESS_TOKEN || '').trim();
    const AS = (process.env.X_ACCESS_SECRET || '').trim();
    const haveX = !!(K && KS && AT && AS);

    let posted = false, tweetId = null, postErr = null, diag = null;
    if (haveX) {
      try {
        const { TwitterApi } = require('twitter-api-v2');
        const x = new TwitterApi({ appKey: K, appSecret: KS, accessToken: AT, accessSecret: AS });
        const r = await x.v2.tweet(text + '\n\n' + SITE + '/archive');
        posted = true; tweetId = r.data && r.data.id;
      } catch (e) {
        postErr = String(e && e.message ? e.message : e).slice(0, 200);
        // shapes only, never values. expected: key≈25, key_secret≈50, token≈50 with '-', token_secret≈45
        diag = {
          key_len: K.length, key_secret_len: KS.length,
          token_len: AT.length, token_has_hyphen: AT.indexOf('-') > 0, token_secret_len: AS.length,
          had_whitespace: [process.env.X_API_KEY, process.env.X_API_SECRET, process.env.X_ACCESS_TOKEN, process.env.X_ACCESS_SECRET]
            .map(v => v !== (v || '').trim()),
        };
        // can these credentials READ? separates mispaired keys (read fails too)
        // from write-permission problems (read works, write refused)
        try {
          const { TwitterApi } = require('twitter-api-v2');
          const probe = new TwitterApi({ appKey: K, appSecret: KS, accessToken: AT, accessSecret: AS });
          const me = await probe.v2.me();
          diag.read_ok = true; diag.acting_as = me.data && me.data.username;
        } catch (e2) {
          diag.read_ok = false; diag.read_err = String(e2 && e2.message ? e2.message : e2).slice(0, 120);
        }
      }
    }

    await db.saveTweet({ body: text, posted, tweet_id: tweetId });

    return send(res, 200, {
      ok: true, posted, dryRun: !haveX, tweet: text,
      tweet_id: tweetId, error: postErr, diag,
      usage: resp.usage ? { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens } : null,
    });
  } catch (e) {
    return send(res, 502, { error: String(e && e.message ? e.message : e).slice(0, 200) });
  }
};
