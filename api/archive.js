// fablerooms backend — the public record. every finished thought, kept.
const db = require('./_db.js');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const data = await db.recentConversations(6);
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
