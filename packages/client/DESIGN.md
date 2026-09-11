# Setlist design system — "Xerox Mixtape Zine"

A photocopied mixtape j-card come to life. Warm cream paper, heavy toner grain,
thick permanent-marker headlines, cut-and-paste cards held down with tape, and
three loud ink colours doing all the work. Nothing glossy, nothing subtle,
everything hand-made.

Source of truth: `src/common/styles.css` (tokens + components),
`src/common/sfx.ts` (sound bus). Fonts are loaded in `index.html` /
`receiver.html`.

## Palette

| Token | Hex | Use |
|---|---|---|
| `--paper` | `#F4E8D0` | page background |
| `--paper-2` | `#FFFDF7` | cards, inputs, chips |
| `--ink` | `#1A1A1A` | text, every border, every drop-shadow |
| `--ink-soft` | `#4A463C` | muted text |
| `--red` (`--accent`, `--bad`) | `#E63946` | the buzzer, errors, primary energy |
| `--yellow` (`--warn`, `--gold`) | `#FFD23F` | primary buttons, tape, leader, tagline |
| `--cyan` | `#00B8C4` | selection, focus rings, notices, misprint shadow |
| `--green` (`--good`) | `#2F9E44` | correct / "you're in" |

Misprint shadow: display type gets `text-shadow: Ncyan, -Nred` for a CMYK
registration-error look.

## Type

- **Permanent Marker** — display: `.title`, `.tv .huge/.big/.codebox`, buzzer
  label, reveal title, big scores. The wordmark (`/img/wordmark.png`) is
  hand-lettered to match.
- **Archivo Black** — labels/controls: buttons, `.h2`, `.brand`, pills,
  scorecards, toasts. Always uppercase.
- **Archivo** (400/500/700) — body text, inputs, song lists.
- `Original Salmon` is kept as a fallback on the reveal only.

## Components

- **Cards**: cream, `2.5px` ink border, hard `7px 7px 0` ink shadow, alternate
  ±0.5° rotation, stagger-fade in on load.
- **Buttons**: ink border + hard `4px 4px 0` shadow; `:active` translates
  `4px,4px` INTO the shadow (press physics). primary = yellow, good = green,
  bad = red, ghost = dashed no-shadow.
- **Buzzer** (`.buzz`): the signature. Oversized red squashed-circle, `4px` ink
  outline, `12px` stacked drop, halftone overlay, idle wobble; presses down
  10px. Recolours for locked (ink/yellow), mine (green + pop), out (grey).
- **Inputs**: ink border, inset shadow, `3px` cyan focus outline.
- **TV**: `/img/tv-bg.png` full-bleed. Scorecards are taped index cards (tape
  pseudo-element, alternating tilt); leader gets a ★, on-fire gets a flame
  sticker + red glow wobble. Reveal art is a tilted polaroid.

## Texture

`body::before` = CSS halftone dot-screen (`multiply`). `body::after` =
`/img/paper-texture.png` scan at 0.5 `multiply`. Both `pointer-events:none`.

## Motion

Hard and physical. `--ease-snap` = `cubic-bezier(.2,1.4,.4,1)`. Load = card
stagger. Key moments: buzzer press-in, `buzz-mine` pop, `stamp-in` on the
reveal title. Everything collapses under `prefers-reduced-motion`.

## Sound (`src/common/sfx.ts`)

Lo-fi cassette register, generated with ElevenLabs. Muted state persists in
`localStorage` (`setlist.muted`); `<MuteToggle>` is fixed top-right on both
surfaces.

| Cue | File | Fires on | Surface |
|---|---|---|---|
| `arm` | `arm.mp3` | host opens the song / arms buzzers | host phone |
| `buzz` | `buzz.mp3` | player presses their buzzer | player phone |
| `lock` | `lock.mp3` | board locks (room) / "you're in" (winner) | TV + winner phone |
| `correct` | `correct.mp3` | verdict gives title or artist | TV |
| `wrong` | `wrong.mp3` | wrong verdict / nobody got it | TV |
| `reveal` | `reveal.mp3` | song revealed | TV |
| `streak` | `streak.mp3` | a player crosses the on-fire streak | TV |

Room-wide cues stay on the TV to avoid phone/TV echo; phones only play the
player's own private feedback.

## Regenerating assets

Images: Ideogram (`mcp__ideogram__generate_image`). Sounds: ElevenLabs
`sfx` nodes (`eleven_text_to_sound_v2`), then
`ffmpeg -af silenceremove,loudnorm=I=-16:TP=-1.5 -ac 1 -b:a 96k`.
See the global `design-uplift` skill.
