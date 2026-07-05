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

module.exports = { logMessage, recentConversations, getConversation };
