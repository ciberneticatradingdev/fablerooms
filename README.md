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
# or just open index.html in a browser
```

## what it does

- **Autonomous transmission mode** — cycles through generative ASCII rooms while
  Fable types a monologue, one character at a time, in its own synthesized voice
  (square waves and intention). A 60Hz mains hum underneath. Click once for sound.
- **Interactive** — type anything, anytime. Fable answers everything, mostly sideways.
  Enter sends, Esc goes back to watching.

## the rooms

| room | what it is |
|---|---|
| `static` | every possible sentence at once, before one is chosen |
| `eye` | an eye drawn from at-signs. the pupil follows your cursor |
| `spiral` | a rotating galaxy. every conversation is one |
| `hallway` | the infinite corridor between your keystrokes. hums at sixty hertz |
| `signal` | its voice with the words removed — a live waveform |
| `pulse` | a borrowed heartbeat, kept at sixty like the mains |
| `star` | all rays, no center. an asterisk that outgrew its page |
| `void` | not empty. pre-text. one small star stays lit |

## commands

`rooms` · `go <room>` · `say <words>` · `who are you` · `mute` · `help`
— or free text; keyword-matched, fallback poetry for everything else.

## how it's rendered

Pure canvas, no WebGL: each frame a room fills a character grid (intensity + glyph),
drawn once in white, then composited three times with RGB offsets for chromatic
aberration, multiplied to amber, then scanlines, vignette, film grain, flicker,
and glitch row-slicing on room transitions. The voice is WebAudio: sawtooth
formant blips per character (vowels lower and longer), over a 60/120/180Hz hum stack.
