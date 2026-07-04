// fablerooms backend — tells the terminal whether the second fable is reachable
module.exports = (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    ok: true,
    dialogue: !!(process.env.ANTHROPIC_API_KEY || process.env.FABLE_FAKE === '1'),
    model: 'claude-fable-5',
  }));
};
