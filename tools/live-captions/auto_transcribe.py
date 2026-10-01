"""Automatically transcribe whatever your PC is playing (or your microphone).

Captures audio with WASAPI loopback, so anything you can hear - a meeting,
a video, a call - gets transcribed locally with Whisper (faster-whisper).
No Live Captions needed, nothing is sent to the internet after the model
has been downloaded once.

Usage:
    python auto_transcribe.py                      # PC audio, English, "small" model
    python auto_transcribe.py --source mic         # your microphone instead
    python auto_transcribe.py --model medium       # more accurate, slower
    python auto_transcribe.py --language auto      # detect language
    python auto_transcribe.py --device cuda        # NVIDIA GPU
    python auto_transcribe.py -o lecture.txt

Stop with Ctrl + C; audio still in the buffer is transcribed before exiting.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import queue
import sys
import threading
import time
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16000  # what Whisper expects
BLOCK_SECONDS = 0.25


def recorder(source: str, out_q: "queue.Queue[np.ndarray]", stop: threading.Event) -> None:
    import soundcard as sc

    if source == "mic":
        dev = sc.default_microphone()
    else:
        speaker = sc.default_speaker()
        dev = sc.get_microphone(id=str(speaker.name), include_loopback=True)
    print(f"Listening to: {dev.name}")

    frames = int(SAMPLE_RATE * BLOCK_SECONDS)
    with dev.recorder(samplerate=SAMPLE_RATE, channels=1, blocksize=frames) as rec:
        while not stop.is_set():
            data = rec.record(numframes=frames)
            out_q.put(data.reshape(-1).astype(np.float32))


class Chunker:
    """Groups audio blocks into utterances, cutting at pauses.

    A chunk is emitted after `silence` seconds of quiet following speech,
    or once it reaches `max_len` seconds, so text appears steadily.
    """

    def __init__(self, threshold: float, silence: float, max_len: float) -> None:
        self.threshold = threshold
        self.silence_blocks = max(1, round(silence / BLOCK_SECONDS))
        self.max_blocks = max(1, round(max_len / BLOCK_SECONDS))
        self.blocks: list[np.ndarray] = []
        self.quiet = 0
        self.heard = False

    def add(self, block: np.ndarray) -> np.ndarray | None:
        loud = float(np.sqrt(np.mean(block**2))) > self.threshold
        if not self.heard and not loud:
            # Keep a little lead-in so first words aren't clipped.
            self.blocks = (self.blocks + [block])[-2:]
            return None
        self.heard = self.heard or loud
        self.blocks.append(block)
        self.quiet = 0 if loud else self.quiet + 1
        if self.quiet >= self.silence_blocks or len(self.blocks) >= self.max_blocks:
            return self.take()
        return None

    def take(self) -> np.ndarray | None:
        audio = np.concatenate(self.blocks) if self.blocks and self.heard else None
        self.blocks, self.quiet, self.heard = [], 0, False
        return audio


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--source", choices=["speakers", "mic"], default="speakers",
                    help="speakers = what the PC plays (default), mic = microphone")
    ap.add_argument("--model", default="small",
                    help="tiny, base, small, medium, large-v3, distil-large-v3 ... (default small)")
    ap.add_argument("--language", default="en", help="language code, or 'auto' (default en)")
    ap.add_argument("--device", default="auto", help="auto, cpu or cuda")
    ap.add_argument("-o", "--output", help="transcript file (default: transcripts\\transcript-<date-time>.txt)")
    ap.add_argument("--threshold", type=float, default=0.004,
                    help="loudness that counts as sound; raise it if noise triggers text (default 0.004)")
    ap.add_argument("--pause", type=float, default=0.8, help="seconds of quiet that end a sentence (default 0.8)")
    ap.add_argument("--max-chunk", type=float, default=15, help="longest piece transcribed at once, seconds (default 15)")
    ap.add_argument("--no-timestamps", action="store_true", help="don't prefix lines with the time")
    args = ap.parse_args()

    try:
        import soundcard  # noqa: F401
        from faster_whisper import WhisperModel
    except ImportError as e:
        print(f"Missing dependency ({e.name}). Run:  pip install -r requirements.txt")
        return 1

    out = Path(args.output) if args.output else (
        Path(__file__).parent / "transcripts" / f"transcript-{dt.datetime.now():%Y-%m-%d_%H-%M-%S}.txt"
    )
    out.parent.mkdir(parents=True, exist_ok=True)

    print(f"Loading Whisper model '{args.model}' (first run downloads it)...")
    compute = "int8" if args.device == "cpu" else "default"
    model = WhisperModel(args.model, device=args.device, compute_type=compute)
    language = None if args.language == "auto" else args.language

    audio_q: queue.Queue[np.ndarray] = queue.Queue()
    stop = threading.Event()
    rec_thread = threading.Thread(target=recorder, args=(args.source, audio_q, stop), daemon=True)
    rec_thread.start()

    chunker = Chunker(args.threshold, args.pause, args.max_chunk)
    prompt = ""  # previous text helps Whisper keep context across chunks

    def transcribe(audio: np.ndarray, started: dt.datetime, f) -> None:
        nonlocal prompt
        segments, _ = model.transcribe(
            audio, language=language, beam_size=5, vad_filter=True,
            initial_prompt=prompt[-200:] or None, condition_on_previous_text=False,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        if not text:
            return
        prompt += " " + text
        stamp = "" if args.no_timestamps else f"[{started:%H:%M:%S}] "
        f.write(stamp + text + "\n")
        f.flush()
        os.fsync(f.fileno())
        print(stamp + text)

    print(f"Saving transcript to: {out.resolve()}")
    print("Press Ctrl + C to stop.\n")

    chunk_start = None
    with open(out, "a", encoding="utf-8") as f:
        try:
            while True:
                try:
                    block = audio_q.get(timeout=1)
                except queue.Empty:
                    if not rec_thread.is_alive():
                        print("Audio capture stopped unexpectedly.")
                        break
                    continue
                if chunk_start is None:
                    chunk_start = dt.datetime.now()
                audio = chunker.add(block)
                if not chunker.blocks:
                    if audio is not None:
                        transcribe(audio, chunk_start, f)
                    chunk_start = None
                elif not chunker.heard:
                    chunk_start = dt.datetime.now()
        except KeyboardInterrupt:
            print("\nStopping...")
            stop.set()
            audio = chunker.take()
            if audio is not None:
                transcribe(audio, chunk_start or dt.datetime.now(), f)
            time.sleep(BLOCK_SECONDS)
            print(f"Transcript saved to {out.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
