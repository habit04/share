"""Save the Windows 11 Live Captions transcript to a text file as it happens.

Live Captions (Win + Ctrl + L) only shows the last few lines and throws the
rest away. This script reads the caption text through Windows UI Automation
every fraction of a second and appends each finished sentence to a
timestamped transcript file, so nothing is lost.

Usage:
    python save_live_captions.py                 # saves to transcripts\\captions-<date>.txt
    python save_live_captions.py -o meeting.txt  # choose the file
    python save_live_captions.py --no-timestamps

Stop with Ctrl + C; the last unfinished sentence is written before exiting.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import subprocess
import sys
import time
from pathlib import Path

WINDOW_CLASS = "LiveCaptionsDesktopWindow"
TEXT_ID = "CaptionsTextBlock"

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def split_segments(text: str) -> list[str]:
    """Break the caption text into lines/sentences, dropping empties."""
    parts: list[str] = []
    for line in text.splitlines():
        parts.extend(s.strip() for s in _SENTENCE_END.split(line))
    return [p for p in parts if p]


def _norm(s: str) -> str:
    return re.sub(r"[^\w]+", " ", s).strip().lower()


class TranscriptMerger:
    """Turns successive snapshots of the caption box into a stream of new lines.

    Every segment except the last one in a snapshot is treated as finished.
    The finished segments are aligned against what has already been written
    (longest suffix of history == prefix of snapshot) so that lines still on
    screen are not written twice as the captions scroll.
    """

    def __init__(self, history: int = 50) -> None:
        self.written: list[str] = []
        self.pending = ""
        self.history = history

    def update(self, text: str) -> list[str]:
        segments = split_segments(text)
        if not segments:
            return []
        finished, self.pending = segments[:-1], segments[-1]
        new = self._unseen(finished)
        self.written.extend(new)
        del self.written[: -self.history]
        return new

    def flush(self) -> list[str]:
        if not self.pending:
            return []
        new = self._unseen([self.pending])
        self.written.extend(new)
        self.pending = ""
        return new

    def _unseen(self, finished: list[str]) -> list[str]:
        done = [_norm(s) for s in self.written]
        cur = [_norm(s) for s in finished]
        for k in range(min(len(done), len(cur)), 0, -1):
            if done[-k:] == cur[:k]:
                return finished[k:]
        # No overlap: either everything scrolled past, or the oldest visible
        # line was revised. Skip lines we wrote very recently to avoid repeats.
        recent = set(done[-len(cur) - 2 :]) if done else set()
        start = 0
        while start < len(cur) and cur[start] in recent:
            start += 1
        return finished[start:]


def find_caption_text(auto):
    window = auto.WindowControl(searchDepth=1, ClassName=WINDOW_CLASS)
    if not window.Exists(0, 0):
        return None
    text = window.TextControl(AutomationId=TEXT_ID)
    return text if text.Exists(0, 0) else None


def launch_live_captions() -> None:
    try:
        subprocess.Popen(["LiveCaptions.exe"], shell=False)
    except OSError:
        # Fallback: the Win + Ctrl + L shortcut opens it too.
        print("Could not start LiveCaptions.exe - press Win + Ctrl + L to open it.")


def main() -> int:
    if sys.platform != "win32":
        print("This script needs Windows 11 with Live Captions.")
        return 1
    try:
        import uiautomation as auto
    except ImportError:
        print("Missing dependency. Run:  pip install -r requirements.txt")
        return 1

    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("-o", "--output", help="transcript file (default: transcripts\\captions-<date-time>.txt)")
    ap.add_argument("--interval", type=float, default=0.3, help="seconds between reads (default 0.3)")
    ap.add_argument("--no-timestamps", action="store_true", help="don't prefix lines with the time")
    ap.add_argument("--quiet", action="store_true", help="don't echo lines to the console")
    args = ap.parse_args()

    out = Path(args.output) if args.output else (
        Path(__file__).parent / "transcripts" / f"captions-{dt.datetime.now():%Y-%m-%d_%H-%M-%S}.txt"
    )
    out.parent.mkdir(parents=True, exist_ok=True)

    # Searching the UI tree can be slow; keep timeouts short so Ctrl+C is responsive.
    auto.SetGlobalSearchTimeout(1)

    merger = TranscriptMerger()
    caption = None
    last_text = None
    warned = False

    def write(lines: list[str], f) -> None:
        for line in lines:
            stamp = "" if args.no_timestamps else f"[{dt.datetime.now():%H:%M:%S}] "
            f.write(stamp + line + "\n")
            if not args.quiet:
                print(stamp + line)
        f.flush()
        os.fsync(f.fileno())

    print(f"Saving Live Captions to: {out.resolve()}")
    print("Press Ctrl + C to stop.\n")

    with auto.UIAutomationInitializerInThread(), open(out, "a", encoding="utf-8") as f:
        try:
            while True:
                if caption is None:
                    caption = find_caption_text(auto)
                    if caption is None:
                        if not warned:
                            print("Live Captions is not open - starting it...")
                            launch_live_captions()
                            warned = True
                        time.sleep(2)
                        continue
                    print("Connected to Live Captions.\n")
                    warned = False
                try:
                    text = caption.Name or ""
                except Exception:
                    # Window closed or rebuilt - write what we have and reconnect.
                    write(merger.flush(), f)
                    caption = None
                    continue
                if text != last_text:
                    last_text = text
                    write(merger.update(text), f)
                time.sleep(args.interval)
        except KeyboardInterrupt:
            write(merger.flush(), f)
            print(f"\nStopped. Transcript saved to {out.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
