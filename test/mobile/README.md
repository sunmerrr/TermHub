# Phone input test (Android emulator + real Gboard)

```bash
npm run test:mobile
```

Taps the real Gboard keys in the emulator's Chrome and, after every step, checks that the
**input field text equals what the terminal received** (DEL applied as erase). Covers typo fixes,
Gboard suggestion swaps, erasing past a space, Korean composition and Enter.

## What it does

- `server.sh` starts a separate TermHub on port 6081 with its own tmux server, state file and no
  tunnel/Discord, so the real server is never touched.
- The terminal runs `keytap.py`: a real shell whose incoming bytes are also logged to
  `/tmp/termhub-mtest/keys.log`.
- `run.py` boots the emulator if needed, opens the page, taps keys and prints PASS/FAIL.
- `cdp.js` reads the input field through Chrome DevTools (`adb forward` to port 6222).

## One-time setup

- Android Studio emulator `Medium Phone` (1080x2400, Google Play image). The key coordinates in
  `run.py` match this screen; other devices need new `KEYS`.
- Gboard → Settings → Languages → add **한국어 (두벌식)**.
- Optional env: `ADB`, `ANDROID_HOME`, `MTEST_AVD`, `MTEST_PORT` (default 6081), `MTEST_DIR`.

Don't click inside the emulator window while it runs: mouse clicks arrive as stylus input and
Gboard switches to a handwriting toolbar (the script turns that off and restarts Gboard on start).
