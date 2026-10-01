# Live Captions Saver & Auto Transcriber (Windows)

There are two small tools here. Each one writes a running transcript to a text file
with timestamps:

| Tool | What it does | Needs |
|---|---|---|
| `save_live_captions.py` | Copies what **Windows 11 Live Captions** shows into a file, so the text that scrolls off the screen is kept | Windows 11 (22H2 or newer) |
| `auto_transcribe.py` | Transcribes **any audio your PC plays** (or your mic) by itself, using Whisper on your computer | Windows 10/11, ~1–2 GB for the model |

Transcripts are saved in `transcripts\` next to the scripts, unless you pass `-o file.txt`.

## Setup (once)

1. Install Python 3.9 or newer from <https://python.org>. In the installer, tick **"Add python.exe to PATH"**.
2. Double-click **`Save Live Captions.bat`** or **`Auto Transcribe.bat`**. The first run installs what it needs.

Or install from a terminal:

```bat
cd tools\live-captions
pip install -r requirements.txt
```

## 1. Save the Live Captions transcript

```bat
python save_live_captions.py
```

- If Live Captions isn't open, the script starts it. You can also open it yourself with **Win + Ctrl + L**.
- Each finished sentence is added to the file right away, so nothing is lost if the PC crashes.
- Press **Ctrl + C** to stop. The last sentence is saved before the script exits.
- In Live Captions ⚙ → *Preferences*, turn on **Include microphone audio** to also caption your own voice.

Options: `-o meeting.txt`, `--no-timestamps`, `--quiet`, `--interval 0.3`.

## 2. Transcribe automatically (no Live Captions)

```bat
python auto_transcribe.py                  :: what the PC is playing
python auto_transcribe.py --source mic     :: your microphone
python auto_transcribe.py --model medium   :: more accurate, slower
python auto_transcribe.py --language auto  :: other languages / auto-detect
python auto_transcribe.py --device cuda    :: use an NVIDIA GPU
```

- The first run downloads the Whisper model. After that, everything runs offline on your PC.
- Text appears in pieces after each pause in speech, or at least every 15 seconds (`--max-chunk`).
- Model sizes: `tiny` / `base` (fastest), `small` (default, a good balance on a CPU), `medium`, `large-v3` (best, and needs a GPU to keep up).
- If background noise produces made-up text, raise `--threshold` (for example `0.01`).

## Troubleshooting

- **"Live Captions is not open" keeps showing up:** Live Captions needs Windows 11 22H2 or newer. Open it once with Win + Ctrl + L and let it download its language files.
- **No text from `auto_transcribe.py`:** check that sound is playing through your *default* output device (the speaker icon in the taskbar).
- **It's too slow and falls behind:** use `--model base`. If you have an NVIDIA GPU, use `--device cuda`.
