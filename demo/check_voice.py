#!/usr/bin/env python3
"""Transcribe each narration clip and compare it with the script, to catch skipped, repeated
or swapped words. The voice model makes those mistakes now and then, and the ear is not
always there to check.

    python demo/check_voice.py            every clip
    python demo/check_voice.py 07,15      these clips

Needs: pip install faster-whisper. Prints one line per clip; CHECK means listen to it.
"""
import json
import os
import re
import sys
import wave

from faster_whisper import WhisperModel

HERE = os.path.dirname(os.path.abspath(__file__))
VOICE = os.path.join(HERE, "out", "voice")

# How the model's spelling choices sound, so they are not counted as mistakes.
SAME = {"dow": "dao", "dao": "dao", "near": "near", "tomás": "tomas", "tomas": "tomas", "soosoo": "susu", "susu": "susu", "0": "zero", "4": "four", "co": "co", "op": "op"}


def words(text):
    out = []
    for w in re.findall(r"[a-z0-9']+", text.lower().replace("-", " ")):
        out.append(SAME.get(w, w))
    return out


def seconds(path):
    with open(path, "rb") as fh:
        data = fh.read()
    i, rate = 12, None
    while i + 8 <= len(data):
        chunk = data[i : i + 4]
        size = int.from_bytes(data[i + 4 : i + 8], "little")
        if chunk == b"fmt ":
            rate = int.from_bytes(data[i + 16 : i + 20], "little")
        if chunk == b"data":
            return size / rate
        i += 8 + size + (size & 1)
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()


def load16k(path):
    """The clip as 16 kHz mono float32, which is what the speech model reads. Reads 16-bit
    PCM and 32-bit float WAV (the voice model writes float)."""
    import numpy as np

    data = open(path, "rb").read()
    i, fmt, ch, rate, bits, pcm = 12, 1, 1, 16000, 16, None
    while i + 8 <= len(data):
        cid, size = data[i : i + 4], int.from_bytes(data[i + 4 : i + 8], "little")
        if cid == b"fmt ":
            fmt = int.from_bytes(data[i + 8 : i + 10], "little")
            ch = int.from_bytes(data[i + 10 : i + 12], "little")
            rate = int.from_bytes(data[i + 12 : i + 16], "little")
            bits = int.from_bytes(data[i + 22 : i + 24], "little")
        elif cid == b"data":
            pcm = data[i + 8 : i + 8 + size]
        i += 8 + size + (size & 1)
    if fmt == 3 or (fmt == 65534 and bits == 32):
        x = np.frombuffer(pcm, dtype=np.float32).astype(np.float32)
    else:
        x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    n = int(len(x) * 16000 / rate)
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def main():
    lines = json.load(open(os.path.join(HERE, "lines.json"), encoding="utf-8"))
    only = set(sys.argv[1].split(",")) if len(sys.argv) > 1 else None
    model = WhisperModel(os.environ.get("WHISPER", "base.en"), device="cpu", compute_type="int8", cpu_threads=4)
    flagged = 0
    for line in lines:
        if only and line["id"] not in only:
            continue
        path = os.path.join(VOICE, f"{line['id']}.wav")
        if not os.path.exists(path):
            print(f"MISSING {line['id']}")
            flagged += 1
            continue
        segs, _ = model.transcribe(load16k(path), language="en", beam_size=5)
        heard = " ".join(s.text.strip() for s in segs)
        want, got = words(line["text"]), words(heard)
        missing = [w for w in want if w not in got]
        extra = len(got) - len(want)
        secs = seconds(path)
        wpm = len(want) / secs * 60
        bad = len(missing) >= 2 or extra >= 2 or extra <= -2 or wpm > 230
        flagged += bad
        print(f"{'CHECK' if bad else 'ok   '} {line['id']} {secs:5.2f}s {wpm:4.0f} wpm  heard: {heard}")
        if bad:
            print(f"        script: {line['text']}")
            if missing:
                print(f"        missing: {' '.join(missing)}")
    print(f"{flagged} clip(s) to listen to")


if __name__ == "__main__":
    main()
