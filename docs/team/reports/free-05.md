# FREE-05: free offline voice, the phone and the chief call (CITY-02/03/04)

Branch `claude/free-05-voice-phone`, starting from `origin/codex/empire-world` at 8512264. Not pushed. Awaiting independent review.

## Requirements recorded before coding

- **FREE_PLAN rule 5:** nothing downloads automatically. Each download shows its name, size and licence, and needs a click.
- **FREE_STACK §3:** sherpa-onnx with Moonshine or Whisper for speech to text and Kokoro for text to speech. No Piper engine (GPL).
- **CITY-02:** contacts with a truthful text chief call. **CITY-03:** voice setup and a microphone test, with a text fallback. **CITY-04:** push-to-talk where each transcript is sent once, with subtitles, audio and cancel.
- **Mobile apps:** the microphone stays off. Voice chat (`src/client/voice.ts`) is untouched.
- **No dependency on FREE-02:** a `chiefBriefing(question?) → { text, source }` seam instead.

## What was built

- **Voice runtime** (`src/server/voice.ts`, `src/shared/voice.ts`):
  - Model catalogue pinned to official sherpa-onnx release assets. Sizes and sha256 come from the GitHub asset API. Whisper Small has no published digest, so its exact size is verified, and the UI says so.
  - Downloads need `confirm: true`, show progress and can be cancelled. On mismatch, the download is deleted and nothing is installed. Unpacking uses the system `tar`.
  - `sherpa-onnx-node` is loaded lazily. It is **not added to package.json**: the owner decides whether it becomes an optional dependency. Without it, the app runs with text.
  - WAV is decoded, and recordings are bounded to 30 s and about 0.96 MB.
  - Audio is dropped after transcription unless the user opts in.
  - Transcripts are pending until they are sent once (a repeat gets 409) or cancelled, and expire after 5 minutes.
- **Chief call** (`src/server/chief-briefing.ts`):
  - `ruleBasedBriefing` is built from the ORG-01 roster, the ORG-03 inbox and the capacity report. A focused question gets the matching report; an unknown one says it can only report records.
  - `routeChief` treats a question as a request for the briefing. “new job: …” becomes `office.create` plus an inbox reconcile: a pending plan that is never approved automatically.
- **Endpoints:** `/api/voice*` and `/api/phone/chief` sit behind sign-in and use the existing same-origin or bearer rule.
- **Game:**
  - 📱 Phone (`src/client/ui/phone.ts`, `phone.css`): contacts, call screen, subtitles, hold-to-talk using the pointer or Space, a confirm/edit/discard step, an optional spoken reply, and Esc layering.
  - Settings → Voice (`voice-setup.ts`).
  - Capture (`src/client/ptt.ts`): getUserMedia, then resampling to a 16 kHz WAV. iOS and Android apps get text.
- **Docs:** `docs/VOICE.md` and the TASKS rows.

## Evidence

All of these passed:

| Check | Result |
| --- | --- |
| `npm run typecheck` | green |
| `npm test` | 767/767 |
| New tests (`tests/voice.test.ts` 11, `voice-server.test.ts` 4, `ptt.test.ts` 2) | all pass |
| `npm run build` | green |
| `tools/phone-ui-check.ts` | 32/32 |
| `mobile-ui-check` | 411/411 |
| `outfit-ui-check` | 29/29 |

The new tests cover:
- the download confirmation, checksum mismatch, size mismatch and cancel;
- a transcript being sent once;
- upload limits (413) and authentication (401/403);
- a truthful briefing from fixture state;
- a pending, unapproved plan;
- the app microphone policy.

The phone UI check ran on isolated fixture port 4871, with Chrome's fake microphone and fake STT/TTS engines. Screenshots are in `docs/team/reports/free-05/`, at 1440x900 (01–07) and 874x402 (08–10, reduced motion and Save-Data):
- voice setup, the download confirmation, progress;
- contacts;
- the chief call with subtitles;
- the push-to-talk confirmation and reply;
- the phone layouts.

Unrelated regenerated screenshots were reverted.

## Review fixes (security review: accept with fixes)

Each fix has a failing-before test in `tests/voice-review.test.ts` (10 tests) or `voice-server.test.ts`. They landed in two commits: 808be49 (fixes 1–5) and d1027c6 (the lower-priority items).

1. **Disk write errors.**
   - What changed: the download now uses `stream/promises.pipeline` and opens the file with `flags: 'wx'`. ENOSPC, EACCES and similar errors mark the download failed with a clear message, and temporary files are removed. There is also a free-space check (3× the archive) before starting.
   - Test: a write stream that fails with ENOSPC.
2. **Cancel and restart races.**
   - What changed: a `running` promise refuses a new download until the old one has fully stopped. The download shows "cancelling", then "cancelled". Temporary names are unique per run. The abort signal is checked after unpacking and before the rename, and it reaches `execFile`.
   - Tests: cancel-then-restart; cancel during unpacking leaves nothing installed.
3. **Event loop.**
   - What changed: only one speech job runs at a time; a second gets 429 "busy". The remaining blocking is documented in `docs/VOICE.md`. **Not done:** moving speech to a worker thread (a follow-up).
   - Test: concurrency gets 429.
4. **Extraction.**
   - What changed: `safeExtract` uses the system tar by absolute path, never PATH. It lists the archive first (`-tjf` and `-tvjf`) and rejects absolute paths, `..`, links and devices. It caps the file count (2,000) and the unpacked size. It unpacks with `--no-same-owner`, then re-checks the files that landed with `lstat`.
   - Test: synthetic `.tar.bz2` archives built with the real bsdtar (one with a `../` entry, one with a symlink, one oversized) are rejected, and nothing is written outside the temporary folder.
5. **Whisper Small (size check only).**
   - What changed: the API needs `confirmUnverified`, and the UI asks a second question titled "No published checksum — size check only" (screenshot `02b`). The computed sha256 is recorded in `installed.json` and `voice.json`, and a reinstall with a different digest shows a warning. It gets the same extraction checks as every model.

Lower-priority items:
- A chief-call retry reuses its requestId.
- *Delete kept recordings* control, plus pruning of recordings after 30 days.
- The `btn-queue` attribute spacing in `index.html` is fixed.
- The models path sent to clients is a display path only.
- Tests for malformed WAVs: a huge chunk size, data before fmt, an odd size, an over-long data size, and a truncated file.
- **The mobile apps keep the microphone off, and there is no toggle yet.**

Re-run after the fixes:

| Check | Result |
| --- | --- |
| typecheck | green |
| `npm test` | 777/777 |
| build | green |
| phone-ui-check | 33/33 |
| mobile-ui-check | 411/411 |

## Re-review fixes (b85d16e)

1. **The unpack cap now counts bytes actually produced.**
   - `safeExtract` lists the archive and then streams every member through a single `tar -xOjf`. The office writes each file itself, splitting the stream by the listed sizes.
   - Past `maxBytes`, or past the listed total, tar is killed at once and the output is removed. A total that differs from the listing is refused.
   - tar no longer writes to disk itself, so it never sets ownership or paths.
   - The listed size is now parsed from the column just before the date, so an owner name with spaces can't shift it.
   - Tests: a real bsdtar archive whose owner is `x 0` (refused at the cap, accepted under a larger cap), and a fake tar that lists 10 bytes but streams 5 MB (stopped at the cap, nothing left behind).
2. **No host paths reach clients.**
   - Failures from tar, file opens and writes show a generic message with the error code. The details go to the host log only.
   - The speech-runtime load error has paths removed.
   - Test: real tar failing on a non-bzip2 file, and an EACCES open error. Neither error contains the data folder, the home folder or the system temp folder.
3. **Free-space check matches the cap.** The reservation is now the archive size plus the unpack cap.

Re-run: typecheck green, `npm test` 781/781, build green, phone-ui-check 33/33.

## Not done, and honest limits

- **No real model was downloaded or run.** The sherpa config follows the official Node addon examples, but transcription latency and accuracy, Kokoro output and the `tar` unpack on Windows have not been measured. A host test with a real model is the next step, and needs the owner's approval for the download.
- **Speech calls block the office host's event loop** while they run. They are synchronous and bounded to a 30 s clip. A worker thread is a follow-up.
- **No device runs.** The iOS and Android apps were not rebuilt; their microphone denial is unchanged, and the page offers text.
- **The rule-based chief can't answer free-form questions,** and says so. FREE-02 can back `ChiefBriefingFn` with `source: 'model'`.
- **"First launch"** is a one-time offer in the first chief call, pointing to Settings → Voice. It is not a separate wizard.
