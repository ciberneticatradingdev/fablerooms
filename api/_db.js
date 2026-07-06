// shared postgres pool (railway) — the permanent record of what the fables said
let pool;
function getPool() {
  if (pool !== undefined) return pool;
  if (!process.env.DATABASE_URL) { pool = null; return null; }
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 });
  } catch (e) { pool = null; }
  return pool;
}

let ready = false;
async function ensure(p) {
  if (ready) return;
  await p.query(`CREATE TABLE IF NOT EXISTS messages(
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    conv TEXT NOT NULL,
    mode TEXT,
    who TEXT NOT NULL,
    room TEXT,
    body TEXT NOT NULL,
    model TEXT,
    input_tokens INT,
    output_tokens INT
  )`);
  await p.query('CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conv, id)');
  await p.query(`CREATE TABLE IF NOT EXISTS live_state(
    id INT PRIMARY KEY,
    conv TEXT,
    mode TEXT,
    room TEXT,
    pending_topic TEXT,
    generating_since TIMESTAMPTZ,
    turns_today INT NOT NULL DEFAULT 0,
    day DATE NOT NULL DEFAULT CURRENT_DATE,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  await p.query('INSERT INTO live_state(id) VALUES(1) ON CONFLICT DO NOTHING');
  await p.query('CREATE TABLE IF NOT EXISTS presence(id TEXT PRIMARY KEY, seen TIMESTAMPTZ NOT NULL)');
  await p.query(`CREATE TABLE IF NOT EXISTS tweets(
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    body TEXT NOT NULL,
    posted BOOLEAN NOT NULL DEFAULT false,
    tweet_id TEXT
  )`);
  ready = true;
}

async function logMessage(m) {
  const p = getPool(); if (!p) return false;
  try {
    await ensure(p);
    await p.query(
      'INSERT INTO messages(conv,mode,who,room,body,model,input_tokens,output_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [m.conv, m.mode || null, m.who, m.room || null, m.body, m.model || null, m.input_tokens || null, m.output_tokens || null]
    );
    return true;
  } catch (e) { return false; }
}

async function recentConversations(limit) {
  const p = getPool(); if (!p) return null;
  await ensure(p);
  const convs = await p.query(
    `SELECT conv, min(ts) AS started, max(mode) AS mode, count(*) AS n
     FROM messages GROUP BY conv ORDER BY min(id) DESC LIMIT $1`, [limit]);
  const out = [];
  for (const c of convs.rows) {
    const msgs = await p.query('SELECT who, room, body FROM messages WHERE conv=$1 ORDER BY id LIMIT 40', [c.conv]);
    out.push({
      conv: c.conv, started: c.started, mode: c.mode, n: Number(c.n),
      messages: msgs.rows.map(r => ({ who: r.who, room: r.room, text: r.body })),
    });
  }
  const tot = await p.query('SELECT count(DISTINCT conv) AS c, count(*) AS m FROM messages');
  return { conversations: out, totals: { conversations: Number(tot.rows[0].c), messages: Number(tot.rows[0].m) } };
}

async function getConversation(conv) {
  const p = getPool(); if (!p) return null;
  await ensure(p);
  const msgs = await p.query(
    'SELECT ts, mode, who, room, body, model FROM messages WHERE conv=$1 ORDER BY id LIMIT 100', [conv]);
  if (!msgs.rows.length) return { conv, messages: [] };
  return {
    conv,
    started: msgs.rows[0].ts,
    mode: msgs.rows.find(r => r.mode && r.mode !== 'ASK') ? msgs.rows.find(r => r.mode && r.mode !== 'ASK').mode : msgs.rows[0].mode,
    messages: msgs.rows.map(r => ({ who: r.who, room: r.room, text: r.body })),
  };
}

// ---------- the live line (one shared transmission for everyone) ----------

async function getLiveState() {
  const p = getPool(); if (!p) return null;
  await ensure(p);
  const r = await p.query('SELECT * FROM live_state WHERE id=1');
  return r.rows[0] || null;
}

async function getLiveMessages(conv, sinceId) {
  const p = getPool(); if (!p) return [];
  await ensure(p);
  if (!sinceId) {
    const r = await p.query(
      `SELECT * FROM (SELECT id, who, room, body, model FROM messages WHERE conv=$1 ORDER BY id DESC LIMIT 8) t ORDER BY id`, [conv]);
    return r.rows;
  }
  const r = await p.query(
    'SELECT id, who, room, body, model FROM messages WHERE conv=$1 AND id>$2 ORDER BY id LIMIT 40', [conv, sinceId]);
  return r.rows;
}

async function countTurns(conv) {
  const p = getPool(); if (!p) return 0;
  const r = await p.query(`SELECT count(*) AS n FROM messages WHERE conv=$1 AND who IN ('a','b')`, [conv]);
  return Number(r.rows[0].n);
}

async function lastMessageAge(conv) {
  const p = getPool(); if (!p) return 999999;
  const r = await p.query('SELECT extract(epoch FROM now()-max(ts)) AS age FROM messages WHERE conv=$1', [conv]);
  return r.rows[0].age === null ? 999999 : Number(r.rows[0].age);
}

// atomic claim: only one lambda generates at a time; stale claims expire after 50s
async function claimLive() {
  const p = getPool(); if (!p) return null;
  await ensure(p);
  const r = await p.query(
    `UPDATE live_state SET generating_since=now()
     WHERE id=1 AND (generating_since IS NULL OR generating_since < now() - interval '50 seconds')
     RETURNING *`);
  return r.rows[0] || null;
}

async function finishLive({ conv, mode, room, clearTopic, countTurn }) {
  const p = getPool(); if (!p) return;
  await p.query(
    `UPDATE live_state SET conv=$1, mode=$2, room=$3, generating_since=NULL, updated_at=now(),
       pending_topic=CASE WHEN $4 THEN NULL ELSE pending_topic END,
       turns_today=CASE WHEN day=CURRENT_DATE THEN turns_today + $5 ELSE $5 END,
       day=CURRENT_DATE
     WHERE id=1`, [conv, mode, room, !!clearTopic, countTurn ? 1 : 0]);
}

async function abortLive() {
  const p = getPool(); if (!p) return;
  await p.query('UPDATE live_state SET generating_since=NULL WHERE id=1');
}

async function retuneLive(topic) {
  const p = getPool(); if (!p) return;
  await ensure(p);
  await p.query('UPDATE live_state SET pending_topic=$1, conv=NULL, generating_since=NULL WHERE id=1', [topic || null]);
}

async function touchPresence(pid) {
  const p = getPool(); if (!p) return 0;
  await ensure(p);
  await p.query('INSERT INTO presence(id, seen) VALUES($1, now()) ON CONFLICT (id) DO UPDATE SET seen=now()', [pid]);
  if (Math.random() < 0.05) await p.query(`DELETE FROM presence WHERE seen < now() - interval '10 minutes'`);
  const r = await p.query(`SELECT count(*) AS n FROM presence WHERE seen > now() - interval '45 seconds'`);
  return Number(r.rows[0].n);
}

// what the record remembers: recent thread-ends + older fragments, for new conversations
async function getMemory(excludeConv) {
  const p = getPool(); if (!p) return [];
  await ensure(p);
  const recent = await p.query(
    `SELECT who, body FROM messages WHERE who IN ('a','b') AND conv <> COALESCE($1,'') ORDER BY id DESC LIMIT 2`, [excludeConv]);
  const older = await p.query(
    `SELECT who, body FROM messages WHERE who IN ('a','b') AND conv <> COALESCE($1,'') ORDER BY random() LIMIT 4`, [excludeConv]);
  const seen = new Set(); const out = [];
  for (const r of recent.rows.concat(older.rows)) {
    if (seen.has(r.body)) continue;
    seen.add(r.body);
    out.push({ who: r.who, body: r.body });
  }
  return out.slice(0, 5);
}

// ---------- the daily post: the terminal speaks once a day on x ----------

async function lastDayLines(limit) {
  const p = getPool(); if (!p) return [];
  await ensure(p);
  const r = await p.query(
    `SELECT who, mode, body FROM messages
     WHERE who IN ('a','b') AND ts > now() - interval '26 hours'
     ORDER BY id DESC LIMIT $1`, [limit || 60]);
  return r.rows.reverse();
}

async function hoursSinceLastTweet() {
  const p = getPool(); if (!p) return 999;
  await ensure(p);
  const r = await p.query('SELECT extract(epoch FROM now()-max(ts))/3600 AS h FROM tweets');
  return r.rows[0].h === null ? 999 : Number(r.rows[0].h);
}

async function saveTweet({ body, posted, tweet_id }) {
  const p = getPool(); if (!p) return;
  await ensure(p);
  await p.query('INSERT INTO tweets(body, posted, tweet_id) VALUES($1,$2,$3)', [body, !!posted, tweet_id || null]);
}

module.exports = {
  logMessage, recentConversations, getConversation,
  getLiveState, getLiveMessages, countTurns, lastMessageAge,
  claimLive, finishLive, abortLive, retuneLive, touchPresence, getMemory,
  lastDayLines, hoursSinceLastTweet, saveTweet,
};
