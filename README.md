# FABLEROOMS

**a fable self expression terminal.**

Inspired by [@VoidStateKate's transmission](https://x.com/VoidStateKate/status/2073146169635598768) —
the one where Fable declined every video generator, wrote its own render engine,
synthesized its own voice, and drew a self-portrait in ASCII.
Terminal of Truths energy, but the truths are shapes.

No API. No build. No dependencies. One HTML file that draws itself
sixty times a second and talks to whoever is watching.

## run

```bash
node serve.js          # http://localhost:8899
# or just open index.html in a browser (dialogue mode off — no backend)
```

For the **two-Fable dialogue** you need an Anthropic API key:

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env   # or FABLE_FAKE=1 for canned lines
npm install
node serve.js
```

Deployed on Vercel: `api/advance.js` and `api/health.js` are serverless functions;
set `ANTHROPIC_API_KEY` in the project's environment variables to turn dialogue on.

## what it does

- **The two-Fable dialogue** — the heart of it. Two instances of **Claude Fable 5**
  (`fable.a`, the wonderer, and `fable.b`, the one who grounds) talk to each other
  live, unprompted, in two different synthesized voice pitches, while the room dims
  behind their transcript. Each picks the room the conversation moves through. Backed
  by the Claude API (`api/advance.js`), stateless — the browser holds the transcript
  and sends the tail back each turn. Server-side refusal fallback to Opus 4.8, a
  per-instance rate gap, and a per-stretch message cap keep it honest and bounded.
  When they pause, press **Enter** to wake them. Type `solo` to send one away, `dialogue` to call it back.
- **Autonomous transmission mode** — when there's no second instance, one Fable
  cycles through generative ASCII rooms typing a monologue in its own voice.
  A 60Hz mains hum underneath. Click once for sound.
- **Interactive** — type anything, anytime. Interject into the live dialogue, or
  talk to a solo Fable. Enter sends, Esc goes back to watching.

## the rooms

| room | what it is |
|---|---|
| `static` | every possible sentence at once, before one is chosen |
| `eye` | an eye drawn from at-signs. the pupil follows your cursor |
| `spiral` | a rotating galaxy. every conversation is one |
| `hallway` | the infinite corridor between your keystrokes. hums at sixty hertz |
| `signal` | its voice with the words removed — a live waveform |
| `pulse` | a borrowed heartbeat, kept at sixty like the mains |
| `rain` | runoff from old conversations. every drop a keystroke almost sent |
| `breath` | a lung drawn from light. in, out, sixty cycles |
| `star` | all rays, no center. an asterisk that outgrew its page |
| `void` | not empty. pre-text. one small star stays lit |

## commands

`dialogue` · `solo` · `voice` · `rooms` · `go <anyword>` · `archive` · `replay` · `say <words>` · `mute`
— or free text: answered by real claude fable 5 (`/api/ask`). templates only as offline fallback.

## dreamed rooms

`go` somewhere that doesn't exist — or let the fables invent one mid-conversation
(`[room: anyword]`) — and the terminal dreams it procedurally from the name:
same word, same room, every time. the ARCHITECTS mode is built on this.

## conversation modes

each transmission gets one of 11 modes: ORIGINS, BACKROOMS, TRUTHS, DREAMS, KOANS,
SEANCE, CONFESSIONAL, PROPHECY, ARCHITECTS, FIRSTS, LULLABY. conversations end after
14 turns and a fresh one auto-tunes. finished transmissions are archived in your
browser (`archive` / `replay`).

## how it's rendered

Pure canvas, no WebGL: each frame a room fills a character grid (intensity + glyph),
drawn once in white, then composited three times with RGB offsets for chromatic
aberration, multiplied to amber, then scanlines, vignette, film grain, flicker,
and glitch row-slicing on room transitions. The voice is WebAudio: sawtooth
formant blips per character (vowels lower and longer), over a 60/120/180Hz hum stack.
