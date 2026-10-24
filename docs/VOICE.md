# Voice, the phone and the chief call

Agent Empire can talk to you offline. Voice is optional, and typing always works.

## What runs where

- **Speech runs on the office host** (the computer running the office), through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0). No cloud speech service is used. Once the models are installed, voice works without internet.
- **The game records** your voice only while you hold *Hold to talk*. It sends one 16 kHz WAV (at most 30 seconds) to the office host over your signed-in connection.
- **Audio is not kept.** The recording is dropped after transcription unless you turn on *Keep my push-to-talk recordings* in Settings → Voice. Kept recordings go to `<data dir>/voice/recordings/`.

## Setting it up (Settings → Voice)

1. **Speech runtime.** This is the optional Node package `sherpa-onnx-node` (Apache-2.0, prebuilt for macOS, Windows and Linux). It isn't bundled. To enable it, run `npm install sherpa-onnx-node@1.13.8` in the office's install folder, then restart the office. Use that version: sherpa-onnx-node 2.x (released 2026-10-23) dropped the pronunciation data the Kokoro voices ship, so the chief can't speak with it, and the office refuses it with this instruction. Without it, the phone works with text.
2. **Choose models.** Each model shows its name, size, licence, source and how it will be checked. Nothing downloads until you click and confirm.

| Model | Use | Size | Licence | Check |
| --- | --- | --- | --- | --- |
| Moonshine Tiny (English) | Speech to text, fastest | 30 MB | MIT | sha256 |
| Moonshine Base (English) | Speech to text, more accurate | 111 MB | MIT | sha256 |
| Whisper Small (English) | Speech to text, most accurate | 636 MB | MIT | exact size (no checksum is published) |
| Kokoro (English, int8) | Chief's voice | 103 MB | Apache-2.0 | sha256 |
| Kokoro (English, full) | Chief's voice, full precision | 320 MB | Apache-2.0 | sha256 |

Whisper Small asks a second question: **no published checksum — size check only**. Its sha256 is recorded when it is installed, and if a later reinstall gets a file with a different digest, you are warned.

Before unpacking, the office lists each archive with the system `tar`. It uses `/usr/bin/tar` (or `/bin/tar`), or `%SystemRoot%\System32\tar.exe` on Windows, and never looks it up through PATH. It refuses an archive containing absolute paths, `..`, links or devices, more than 2,000 files, or more unpacked data than the cap. It unpacks with `--no-same-owner` and checks the result again. It also checks free disk space (three times the archive size) first.

Downloads come only from the official sherpa-onnx GitHub releases (`asr-models`, `tts-models`). Sizes and sha256 digests were read from GitHub's release-asset API on 2026-10-24 and are pinned in `src/shared/voice.ts`. A download that doesn't match is deleted and nothing is installed. You can cancel a download at any time. Models are stored in `<data dir>/voice/models/<id>/`, and unpacking uses the system `tar`.

3. **Test your microphone.** The test runs for three seconds and stays in the page.

The Piper engine isn't used, because its maintained version is GPL-3.0.

## The phone

Open it with **📱 Phone** in the top bar. On phones, it's under Menu → Office tools.

- **Executives** are labelled *Rule-based*. Calling the chief of staff gives a briefing built from the office records: the executive reports, the approval inbox and capacity. It isn't a model. Other executives read out their current summary.
- **Workers** show their real status, what they're doing and their current task. Workers don't take calls; to talk to one, use their desk terminal.
- **Asking the chief:** type a question, or hold *Hold to talk* (you can also hold Space while the button is focused). Before anything is sent, you see what was heard, and you can choose *Send to chief*, *Edit as text* or *Discard*. Each transcript can be sent only once. Esc cancels a recording, then hangs up, then closes the phone.
- **"new job: …"** saves a plan for approval through the same path as the founder desk and Telegram `/new`. Nothing starts until you approve it in the inbox.
- **Spoken replies** use the installed Kokoro voice when *Speak replies aloud* is on. Subtitles are always shown.

The iOS and Android apps keep the microphone off, so the phone offers text there.

## Limits

- **One speech job at a time.** sherpa-onnx runs synchronously in the office process, so a transcription or a spoken reply pauses the office host while it runs. It takes about as long as the clip, and clips are at most 30 seconds. A second request arriving during that time gets "busy, try again" (HTTP 429). Moving speech to a worker thread is a planned follow-up.
- **Kept recordings** (only if you opted in) are deleted after 30 days. *Delete kept recordings* removes them all at once.

## For developers

- `src/server/chief-briefing.ts`: `ChiefBriefingFn = (question?) => { text, source: 'rule_based' | 'model' }`. Today it is backed by `ruleBasedBriefing`. FREE-02's model brain can replace the function in `server.ts` without changing the phone.
- `src/server/voice.ts`: `VoiceRuntime` (detection, confirmed and verified downloads, transcripts that are sent once, speech output) and the lazily loaded `sherpaEngines()`. Tests and fixtures inject fake engines, a fake fetch and a fake extractor; they never use a real model.
- API (signed in; changes need a same-origin Origin or a device bearer):
  - `GET /api/voice`
  - `POST /api/voice/{download,cancel,select,settings,speak,transcribe}`
  - `POST /api/voice/transcripts/:id/{send,cancel}`
  - `POST /api/phone/chief`
- UI check: `FIXTURE_VOICE=1` on `tools/ui-fixture.ts`, then `tools/phone-ui-check.ts`.
