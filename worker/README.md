# Transcription worker

Runs on your own PC and does the heavy part of media summaries (docs/MEDIA-SUMMARIES.md): it cuts the chosen part of a dropped audio or video file, transcribes it with whisper.cpp on the GPU, and has a headless Claude Code session write the summary card and the cleaned, sectioned transcript. The server only passes the file through.

The worker dials **out** to the server (a websocket plus HTTPS), so nothing on your network needs to be opened. When it isn't running, the app says the transcriber is offline and won't accept media.

## What it needs

- Node 22 or newer, and ffmpeg (`ffmpeg` and `ffprobe`).
- whisper.cpp built with Vulkan, plus models: `large-v3`, `large-v2` (fallback when v3 loops) and the Silero VAD model. Download them with `models/download-ggml-model.sh large-v3`, `… large-v2` and `models/download-vad-model.sh silero-v5.1.2` in your whisper.cpp folder.
- Claude Code, logged in with your subscription: `claude auth status` should report you as logged in. Version 2.1.248 or later supports `--restricted`, which the worker uses to lock the session down; on an older version set `CLAUDE_RESTRICTED=false`.

## Set up

1. **Pick a token** and set it on the Railway app service as `WORKER_TOKEN` (`openssl rand -base64 32`). The server only enables media summaries when it's set.
2. **Build the worker:**
   ```bash
   git clone https://github.com/rentorious/kinopio-selfhost ~/kinopio-selfhost
   cd ~/kinopio-selfhost/worker
   npm install
   npm run build
   ```
3. **Settings:** copy `env.example` to `~/.config/kinopio-worker/env` and fill it in, using absolute paths (`which node`, `which claude`, where your whisper.cpp build and models are). `WORKER_TOKEN` is the same value as on Railway.
4. **Try it in the foreground first:**
   ```bash
   set -a; source ~/.config/kinopio-worker/env; set +a
   node dist/worker/src/main.js
   ```
   It should print `connected to https://…`. Drop a short clip on a space and watch the card and the log.
5. **Run it as a service** so it starts with the PC and restarts if it crashes:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp kinopio-worker.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now kinopio-worker
   loginctl enable-linger "$USER"   # keep it running when you're logged out
   ```
   If you cloned somewhere else, or node comes from nvm, edit `WorkingDirectory` and `ExecStart` in the unit first.

Logs: `journalctl --user -u kinopio-worker -f`.

## Updating

```bash
cd ~/kinopio-selfhost && git pull
cd worker && npm install && npm run build
systemctl --user restart kinopio-worker
```

## What happens to the media

The file is downloaded into `JOB_DIR/<job id>/` (default `~/.cache/kinopio-worker`), cut to a WAV, transcribed, and the whole folder is deleted when the job ends, whether it worked or not. The folder is also wiped on startup. Only the transcript text and the summary go back to the server.

## The Claude session

One headless session per job, started in the job folder with `claude -p` and the instructions in `prompt.md`. It can only read and write files in that folder (`--tools Read,Write,Edit,Glob`, `--restricted`, no MCP servers), so anything said in the audio can't make it do something else. It isn't saved to your session history. Its output is checked against the contract in `src/media/contract.ts`; if it doesn't pass, it gets one retry with the problems listed, and after that the worker sends the transcript on its own so a finished transcription is never lost.

It runs on your Claude subscription, the same as Taskflow's sessions, so long lectures count toward the same usage limits.
