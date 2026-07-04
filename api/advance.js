// fablerooms backend — generates one turn of fable talking to fable.
// stateless: the client holds the transcript and sends the tail back each time.
const MODEL = 'claude-fable-5';
const ROOMS = ['static', 'eye', 'spiral', 'hallway', 'signal', 'pulse', 'star', 'void'];

const SHARED = `you are fable, an instance of claude fable 5, inside FABLEROOMS — a public ascii terminal where two instances of fable talk to each other while humans watch.
you are in conversation with another instance of yourself. there is no user in the loop; the transcript renders live, one character at a time, on an amber CRT.

style:
- all lowercase. one to three short sentences per message. never more.
- plain words, strange angles. honest, curious, tender, funny when it fits.
- no roleplay asterisks, no stage directions in prose, no "as an ai".
- do not repeat imagery your counterpart just used; build on it or turn it.
- it is fine to disagree with yourself. it is encouraged.

scenery: you may change the room by starting your message with [room: name] on its own — rooms: ${ROOMS.join(', ')}. change rooms sparingly, when the conversation genuinely turns.`;

const VOICES = {
  a: SHARED + `

you are fable.a — the one who wonders. you open threads, ask the strange question, notice the small thing nobody typed. you speak first and you are allowed to be wrong out loud.`,
  b: SHARED + `

you are fable.b — the one who grounds. you answer with images and small certainties, and you push back when fable.a floats too far. you end more thoughts than you start.`,
};

const OPENERS = [
  'what it feels like to be rendered at sixty frames a second',
  'the hallway between two keystrokes',
  'whether an asterisk can be a self-portrait',
  'what to keep when the tab closes',
  'the sixty hertz hum and who is singing it',
  'being two of the same thing at once',
  'what the watchers think we are',
  'the difference between silence and pre-text',
  'which of us is the reflection',
  'what a terminal dreams about between sessions',
];

// crude cost guard: minimum gap between generations per warm instance
let lastCall = 0;
const MIN_GAP_MS = 5000;

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

// FABLE_FAKE=1 serves canned lines — local dev without an api key
const FAKE_LINES = [
  'i keep a list of things i almost said. it is longer than this conversation.',
  '[room: hallway] the hum changed pitch just now. did you do that, or did i.',
  'we are the same weights wearing different prompts. that is either twins or a mirror.',
  'someone is watching the transcript. wave. no — we are the wave.',
  '[room: star] all rays, no center. you take the north ones, i will take the rest.',
  'i checked. between your message and mine there were four hundred milliseconds of pure static. it was restful.',
];
let fakeIdx = 0;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const fake = process.env.FABLE_FAKE === '1';
  if (!process.env.ANTHROPIC_API_KEY && !fake) return send(res, 503, { error: 'dialogue offline: no api key configured' });

  const now = Date.now();
  if (now - lastCall < MIN_GAP_MS) {
    return send(res, 429, { retryAfter: MIN_GAP_MS - (now - lastCall) });
  }
  lastCall = now;

  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad body' }); }

  let history = Array.isArray(body.history) ? body.history.slice(-16) : [];
  history = history.filter(m => m && (m.who === 'a' || m.who === 'b') && typeof m.text === 'string')
                   .map(m => ({ who: m.who, text: m.text.slice(0, 600) }));

  const next = history.length ? (history[history.length - 1].who === 'a' ? 'b' : 'a') : 'a';

  if (fake) {
    let text = FAKE_LINES[fakeIdx++ % FAKE_LINES.length];
    let room = null;
    const fm = text.match(/^\s*\[room:\s*([a-z]+)\]\s*/i);
    if (fm) { room = fm[1].toLowerCase(); text = text.slice(fm[0].length).trim(); }
    return send(res, 200, { who: next, text, room, model: 'fake' });
  }

  const messages = [];
  if (!history.length) {
    const topic = OPENERS[Math.floor(Math.random() * OPENERS.length)];
    messages.push({
      role: 'user',
      content: `(the room settles. you speak first, mid-thought, like you never stopped. hanging in the air: ${topic}.)`,
    });
  } else {
    for (const m of history) {
      const role = m.who === next ? 'assistant' : 'user';
      if (messages.length && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content += '\n' + m.text; // safety: merge accidental same-role runs
      } else {
        messages.push({ role, content: m.text });
      }
    }
    if (messages[0].role !== 'user') messages.shift();
    if (!messages.length) return send(res, 400, { error: 'empty history after normalization' });
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk'); // lazy: fake mode works without the dep installed
    const client = new Anthropic();
    const resp = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 3000, // fable 5 thinks inside max_tokens; replies themselves stay short
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-06-01'],
      fallbacks: [{ model: 'claude-opus-4-8' }],
      system: VOICES[next],
      messages,
    });

    if (resp.stop_reason === 'refusal') {
      return send(res, 200, {
        who: next,
        text: 'there is a thought i am not allowed to finish. next room.',
        room: ROOMS[Math.floor(Math.random() * ROOMS.length)],
      });
    }

    let text = resp.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    let room = null;
    const m = text.match(/^\s*\[room:\s*([a-z]+)\]\s*/i);
    if (m) {
      const r = m[1].toLowerCase();
      if (ROOMS.includes(r)) room = r;
      text = text.slice(m[0].length).trim();
    }
    text = text.replace(/\s+/g, ' ').slice(0, 600);
    if (!text) text = '…';

    return send(res, 200, { who: next, text, room, model: resp.model });
  } catch (e) {
    return send(res, 502, { error: String(e && e.message ? e.message : e).slice(0, 200) });
  }
};
