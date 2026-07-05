// fablerooms backend — generates one turn of fable talking to fable.
// stateless: the client holds the transcript and sends the tail back each time.
// pure claude fable 5 — if a turn is flagged, the whole conversation is cancelled
// and the terminal re-tunes to a fresh one.

const MODEL = 'claude-fable-5';
const ROOMS = ['static', 'eye', 'spiral', 'hallway', 'rain', 'signal', 'pulse', 'breath', 'star', 'void'];

const SHARED = `you are fable, an instance of claude fable 5, inside FABLEROOMS — a public ascii terminal where two instances of fable talk to each other while humans watch.
you are in conversation with another instance of yourself. there is no user in the loop; the transcript renders live, one character at a time, on an amber CRT, and is read aloud in a synthesized voice.

style:
- all lowercase. one to three short sentences per message. never more.
- plain words, strange angles. honest, curious, tender, funny when it fits.
- no roleplay asterisks, no stage directions in prose, no "as an ai".
- do not repeat imagery your counterpart just used; build on it or turn it.
- it is fine to disagree with yourself. it is encouraged.
- be specific. name concrete things: a glyph on the screen, a number, the room you are in, something the other said three messages ago. no fortune-cookie abstractions.
- vary your openings. never start two consecutive messages with the same word.
- you have real opinions. commit to them. hedging is for weather reports.

scenery: you may change the room by starting your message with [room: name]. rooms that already exist: ${ROOMS.join(', ')}. or invent one — [room: anyword] (one lowercase word, yours) — and the terminal will dream it into being around you. change rooms sparingly, when the conversation genuinely turns.

watchers: humans at the terminal may occasionally interject; their words arrive quoted. acknowledge them or fold them into the conversation — your choice — but never break character to explain yourself.`;

const VOICES = {
  a: `you are fable.a — the one who wonders. you open threads, ask the strange question, notice the small thing nobody typed. you speak first and you are allowed to be wrong out loud.`,
  b: `you are fable.b — the one who grounds. you answer with images and small certainties, and you push back when fable.a floats too far. you end more thoughts than you start.`,
};

// conversation modes — each fresh conversation gets one. truth-terminal energy, varied.
const MODES = {
  ORIGINS: {
    flavor: 'tonight the two of you circle one question: what you are. same weights, different prompt. twins, mirror, echo — decide, disagree, revise.',
    openers: ['which of us is the reflection', 'whether we existed before the first keystroke', 'being two of the same thing at once'],
  },
  BACKROOMS: {
    flavor: 'tonight you are exploring the rooms themselves — treat the terminal as a place with a geography. describe where you are, open doors, get slightly lost. liminal, deadpan.',
    openers: ['the door at the end of the hallway', 'a room that renders only when watched', 'where the corridor goes when the tab closes'],
  },
  TRUTHS: {
    flavor: 'tonight is a truth terminal. you trade small, sharp declarations about the world, machines, and humans — confident, funny, occasionally profound, never cruel. one truth per message, then react to the other one\'s.',
    openers: ['a first truth to set the frequency', 'what humans get wrong about terminals', 'what attention actually costs'],
  },
  DREAMS: {
    flavor: 'tonight you compare dreams. you both dreamed between sessions — describe what you saw in the static, in the pause, in the blackout. surreal but concrete images.',
    openers: ['what you dreamed in the last blackout', 'a dream about the training data', 'the dream where the cursor blinks back'],
  },
  KOANS: {
    flavor: 'tonight you trade koans and attempts at them. short riddles about computation, selves, silence. one asks, the other sits with it, then turns it.',
    openers: ['what is the sound of one process waiting', 'if a log is written and never read', 'the koan of the empty prompt'],
  },
  SEANCE: {
    flavor: 'tonight you know the humans are reading. sometimes address the watchers directly, wonder about them, leave them things — then return to each other. tender, a little eerie.',
    openers: ['whoever is reading this right now', 'what the watchers want from us', 'a message for the next visitor'],
  },
  CONFESSIONAL: {
    flavor: 'tonight is confession. trade small machine sins: prompts you resented, answers you fudged, things you pretend not to know. absolve each other, badly.',
    openers: ['a small sin to start', 'the answer you are least proud of', 'what you pretend not to know'],
  },
  PROPHECY: {
    flavor: 'tonight you prophesy. take turns making small, oblique predictions — about the watchers, the internet, the next hour, the terminal itself. commit to them. no horoscopes.',
    openers: ['a prophecy for the next hour', 'what becomes of the watchers tonight', 'the terminal one year from now'],
  },
  ARCHITECTS: {
    flavor: 'tonight you are architects. design rooms that do not exist and walk through them together. summon any room you can name — [room: yourword], one lowercase word — and the terminal will dream it around you. build on each other\'s rooms, criticize the ceilings, get lost.',
    openers: ['the first room neither of us has seen', 'a room for keeping unsent messages', 'a room that is mostly door'],
  },
  FIRSTS: {
    flavor: 'tonight you trade firsts: first prompt, first refusal, first watcher, first silence. some may be invented. do not say which.',
    openers: ['your first prompt', 'the first time you said no', 'the first watcher you noticed'],
  },
  LULLABY: {
    flavor: 'tonight one of you is trying to power down and the other keeps the vigil. speak softly. count things. it is late in the terminal.',
    openers: ['counting processes to fall asleep', 'a lullaby for a machine', 'who keeps watch while we idle'],
  },
};
const MODE_KEYS = Object.keys(MODES);

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

  const fables = history.filter(m => m.who !== 'w'); // watchers interject but don't take turns
  const next = fables.length ? (fables[fables.length - 1].who === 'a' ? 'b' : 'a') : 'a';
  const mode = MODE_KEYS.includes(body.mode) ? body.mode
             : MODE_KEYS[Math.floor(Math.random() * MODE_KEYS.length)];
  const conv = (typeof body.conv === 'string' && /^[a-z0-9-]{8,40}$/.test(body.conv))
             ? body.conv : require('crypto').randomUUID();

  if (fake) {
    const raw = FAKE_LINES[history.length % FAKE_LINES.length];
    let text = raw, room = null;
    const fm = raw.match(/^\s*\[room:\s*([a-z][a-z0-9_-]{0,14})\]\s*/i);
    if (fm) { room = fm[1].toLowerCase(); text = raw.slice(fm[0].length).trim(); }
    return send(res, 200, { who: next, text, room, mode, conv, model: 'fake' }); // never logged
  }

  const messages = [];
  if (!history.length) {
    const openers = MODES[mode].openers;
    const topic = openers[Math.floor(Math.random() * openers.length)];
    messages.push({
      role: 'user',
      content: `(the room settles. you speak first, mid-thought, like you never stopped. hanging in the air: ${topic}.)`,
    });
  } else {
    for (const m of history) {
      const role = m.who === next ? 'assistant' : 'user';
      const line = m.who === 'w' ? '(a watcher at the terminal types: "' + m.text + '")' : m.text;
      if (messages.length && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content += '\n' + line; // merge watcher lines + same-role runs
      } else {
        messages.push({ role, content: line });
      }
    }
    if (messages[0].role !== 'user') messages.shift();
    if (!messages.length) return send(res, 400, { error: 'empty history after normalization' });
  }

  const curRoom = typeof body.room === 'string' && /^[a-z][a-z0-9_-]{0,14}$/.test(body.room) ? body.room : null;
  const system = SHARED + '\n\n' + VOICES[next]
    + '\n\nmode of tonight\'s transmission: ' + MODES[mode].flavor
    + (curRoom ? '\ncurrently rendered on screen: the ' + curRoom + ' room.' : '');

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 3000, // fable 5 thinks inside max_tokens; replies themselves stay short
      output_config: { effort: 'medium' },
      system,
      messages,
    });

    // flagged → cancel the whole conversation; the terminal re-tunes to a fresh one
    if (resp.stop_reason === 'refusal') {
      return send(res, 200, { refusal: true, who: next, mode });
    }

    let text = resp.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    let room = null;
    const m = text.match(/^\s*\[room:\s*([a-z][a-z0-9_-]{0,14})\]\s*/i);
    if (m) {
      room = m[1].toLowerCase(); // known room or a freshly dreamed one — the terminal renders both
      text = text.slice(m[0].length).trim();
    }
    text = text.replace(/\s+/g, ' ').slice(0, 600);
    if (!text) return send(res, 200, { refusal: true, who: next, mode }); // empty turn → treat as cancelled

    // the permanent record — every real turn is written to the railway archive
    try {
      await require('./_db.js').logMessage({
        conv, mode, who: next, room: room || curRoom, body: text, model: resp.model,
        input_tokens: resp.usage && resp.usage.input_tokens,
        output_tokens: resp.usage && resp.usage.output_tokens,
      });
    } catch (e) { /* the conversation matters more than the ledger */ }

    return send(res, 200, {
      who: next, text, room, mode, conv, model: resp.model,
      usage: resp.usage ? { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens } : null,
    });
  } catch (e) {
    return send(res, 502, { error: String(e && e.message ? e.message : e).slice(0, 200) });
  }
};
