# Voice

Voice lets you work with your sessions and with Cora without the keyboard. Hold a key and speak a prompt to the session
you're looking at, talk to Cora as you would to a colleague, or just say "Hey Cora". Replies can be read back to you:
a short spoken summary at the end of each turn, or the whole reply. Cora also tells you out loud when a session needs
you. Voice is off until you turn it on, and it uses your own ElevenLabs account for speech.

## Setting it up

1. Open **Settings › Voice** and turn on **Turn on voice**.
2. Paste an ElevenLabs API key into **ElevenLabs key** and choose **Save**.

Cora checks the key and shows what it can do: **read aloud**, **push-to-talk** and **your voice list**. The key stays
with Cora on this computer. **Remove** takes it out.

### The ElevenLabs key

Create the key in ElevenLabs under **Developers › API keys › Create key**, and give it these permissions:

| Permission | What it's for |
|---|---|
| **Text to Speech** | Reading replies aloud, and Cora's spoken answers |
| **Speech to Text** | Push-to-talk, talking to Cora, and "Hey Cora" |
| **Voices: read** | Listing your own voices in Settings |

A key without **Voices: read** still works: you get ElevenLabs' standard voices, and can paste any voice's ID. A key
without **Speech to Text** can read aloud, but you can't talk to Cora; for sessions, Claude Code's own `/voice` in the
terminal still works.

## Push-to-talk to a session

Push-to-talk turns what you say into a prompt for the session you're looking at.

1. Hold `Ctrl+Shift+Space` anywhere in Cora, the terminal included, or hold the mic button over the scene.
2. Speak. Your words appear as they're recognised, with the session's name, so you know where they're going.
3. Let go.

What happens next is up to you, in **To sessions**:

- **Review, Enter sends** (the default): your words land in the session's composer, or in a small review box, to
  check and change first. `Enter` sends, `Esc` cancels.
- **Send at once**: they go straight in.

Recognition knows the session's project name and the files it has been working on, so names like `orders.ts` come out
right more often.

If the session isn't running inside Cora, your words are copied to the clipboard instead, to paste where it runs.

## Talking to Cora

Talking to [Cora](cora.md) is a conversation: you speak, Cora answers aloud, you reply.

- Hold `Ctrl+Space` anywhere in Cora, speak, and let go.
- Or choose **Talk** on Cora's bridge card, or the mic in its console. Cora listens until you pause (see **Stop
  listening** below), then sends.
- Or press `Ctrl+Alt+Space` anywhere in Windows: Cora comes to the front and listens. Press it again to stop.

While you speak, Cora's card shows your words as it hears them. Cora also knows which session you're looking at, so
"this one" and "here" mean that session.

Settings that shape the conversation:

- **Talking to Cora**: **Send when I stop** (the default) sends your words the moment you finish. **Review, Enter
  sends** puts them in the console to check first.
- **Stop listening**: when you click to talk, how long a pause ends it (**After a short pause**, **After a pause**,
  **After a long pause**), or **When I click** again. Holding a key always listens until you let go.
- **Answer straight away**: when your words go, a quick spoken line ("Okay, I'll check the app-api pipeline.") while
  the real answer is worked out, so there's no silence. It only says what will be looked at, never a result. Small talk
  gets no line. Each one is a small Haiku call on your Claude login. This applies to spoken prompts to sessions too.
- **Say replies aloud**, in **Settings › Cora Orchestrator**: Cora ends each reply with a sentence or two written to be
  heard, and says it.

## "Hey Cora"

With the wake word on, you can start talking to Cora without touching anything: say "Hey Cora", wait for the chime,
then speak.

Turn it on with **Listen for "Hey Cora"** in **Settings › Voice**. The wake word is recognised on this computer.
Nothing you say leaves it until Cora hears "Hey Cora"; then your words go to Cora as they would with **Talk**.

- **Sensitivity**: **Fewer false starts**, **Balanced** or **Catches more** (for a noisy room).
- **Keep listening after Cora answers**: a few seconds to follow up, with no wake word needed.

A small mic on Cora's bridge card shows it's listening. Click it to mute the wake word, and again to listen. It waits
while something else is listening or speaking, and needs voice on, a key with **Speech to Text**, and Cora's agent
running.

## Reading aloud

**Read aloud** decides what's read to you without asking:

| Choice | What you hear |
|---|---|
| **Only when I click** | Nothing on its own. Every reply in the transcript has a speaker button. |
| **Short summaries** (the default) | At the end of each turn, Claude says a sentence or two, written to be heard. From any session; one you're not looking at is named first ("In app-api: …"). Applies to sessions started after you choose it. |
| **Full replies** | Each finished reply in the session you're looking at, with code left out. **Read up to** sets how much: **~1 paragraph**, **~2 paragraphs** or **~whole reply**. |

The speaker toggle in the live activity, under the transcript, turns automatic reading off and back on for every
session. Speaking over a reply, or pressing `Esc`, stops it.

### Announcements

Under **Also say it when**, Cora can say short lines like "Claude wants to run npm test in app-api":

- **A session needs a permission decision** (on by default)
- **A background command finishes** (on by default)
- **A tool fails**, in the session you're looking at
- **A GitLab pipeline finishes**, one a session follows (on by default)

Summaries and failures wait their turn: they never talk over something being read or over you. Nothing is announced
while you're speaking.

## Voices, pronunciation and pace

Under **The voice**:

- **Voice**: the voice for your sessions, from your ElevenLabs voices. **Preview** plays a sample.
- **Cora's voice**: a second voice for Cora, so you can tell it from your sessions. **Same as sessions** uses one voice
  for both.
- **Voice ID** (or **Or a voice ID**): paste the ID of any ElevenLabs voice, then **Use**.
- **Model**: faster models start speaking sooner; slower ones sound more natural.

  | Model | |
  |---|---|
  | Flash v2.5 (the default) | fastest, half the price |
  | v4 Turbo | near-v4 quality, still quick |
  | v3 | expressive |
  | v4 | best quality, slower to start |
  | Multilingual v2 | natural and steady, slowest to start |

- **Steadiness**: **Steady**, **Balanced** or **Expressive**.
- **Pace**: **Slower**, **Normal** or **Faster**.

Under **How it's said**:

- **Direction**: how every line sounds, in ElevenLabs' audio tags, such as `[relaxed, warm, unhurried]`. Needs a v3 or
  v4 model.
- **Cora's direction**: the same for Cora's lines, so it differs in manner too.
- **Style**: **None**, **Some** or **More** character. Not on v4, Flash or Turbo models.
- **Pronunciations**: say this as that, before the text goes to ElevenLabs. Whole words, any case. For example,
  `kubectl` → `cube control`. Leave the second box empty to leave a word out.

## Shortcuts

| Keys | What they do |
|---|---|
| `Ctrl+Shift+Space` (hold) | Speak a prompt to the session you're looking at |
| `Ctrl+Space` (hold) | Talk to Cora |
| `Ctrl+Alt+Space` | Talk to Cora from anywhere in Windows (again to stop) |
| `Enter` / `Esc` | Send or cancel the words you're reviewing |
| `Esc` | Stop reading aloud |
| "Hey Cora" | Talk to Cora, hands-free |

`Ctrl+Space` and `Ctrl+Alt+Space` need Cora's agent on. All of Cora's shortcuts are in [Reference](reference.md).

## Good to know

- Speech goes through your ElevenLabs account and counts toward its usage. Your voice is sent to ElevenLabs only while
  Cora is listening, after you press a key or say "Hey Cora". Text read aloud is sent to convert it to speech. See
  [Security and privacy](security-and-privacy.md).
- The command palette (`Ctrl+K`) has **Turn voice on** and **Turn voice off**.
- If Windows blocks the microphone, allow it in **Windows Settings › Privacy › Microphone**.
- When Cora's reply goes to your phone (a message you sent from its [Slack DM](cora.md#coras-slack-bot)), it isn't
  read aloud at your desk.
- Short summaries depend on Claude writing them, so they start with sessions begun after you choose that setting.
  See [Sessions](sessions.md) and [Seeing the work](seeing-the-work.md) for the transcript and its speaker buttons.
