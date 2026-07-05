// fablerooms backend — the public record. every finished thought, kept.
// GET /api/archive            → recent conversations + totals
// GET /api/archive?limit=20   → more of them (max 24)
// GET /api/archive?conv=<id>  → one full conversation
const db = require('./_db.js');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const q = require('url').parse(req.url, true).query;
    let data;
    if (typeof q.conv === 'string' && /^[a-z0-9-]{8,45}$/.test(q.conv)) {
      data = await db.getConversation(q.conv);
    } else {
      const limit = Math.min(24, Math.max(1, parseInt(q.limit, 10) || 6));
      data = await db.recentConversations(limit);
    }
    if (!data) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: 'no database attached' }));
    }
    res.statusCode = 200;
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: String(e && e.message ? e.message : e).slice(0, 200) }));
  }
};
