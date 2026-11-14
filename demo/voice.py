#!/usr/bin/env python3
"""Speak the narration, one line per file, with Chatterbox (an open-source voice model).

    python demo/voice.py              every line in demo/lines.json that has no clip yet
    python demo/voice.py 07,15        only these lines, replacing their clips
    python demo/voice.py 07,15 3      the same, with a different random seed (a retake)

Writes demo/out/voice/<id>.wav. Runs on the CPU: a line takes a few minutes.
Needs: pip install chatterbox-tts torchaudio. The narration is an AI voice; say so wherever
the video is posted.
"""
import ctypes
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "voice")


def free_gb():
    """Free physical memory on Windows; a large number elsewhere, so the wait is skipped."""
    if os.name != "nt":
        return 99.0

    class Mem(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_ulong),
            ("load", ctypes.c_ulong),
            ("total", ctypes.c_ulonglong),
            ("avail", ctypes.c_ulonglong),
            ("total_page", ctypes.c_ulonglong),
            ("avail_page", ctypes.c_ulonglong),
            ("total_virtual", ctypes.c_ulonglong),
            ("avail_virtual", ctypes.c_ulonglong),
            ("avail_extended", ctypes.c_ulonglong),
        ]

    m = Mem()
    m.length = ctypes.sizeof(Mem)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.avail / 2**30


def main():
    lines = json.load(open(os.path.join(HERE, "lines.json"), encoding="utf-8"))
    only = set(sys.argv[1].split(",")) if len(sys.argv) > 1 and sys.argv[1] != "all" else None
    seed_offset = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    os.makedirs(OUT, exist_ok=True)
    todo = [l for l in lines if (l["id"] in only if only else not os.path.exists(os.path.join(OUT, f"{l['id']}.wav")))]
    if not todo:
        print("nothing to do")
        return

    # The model needs about 2.5 GB. Loading it on a machine that is already short would
    # push everything into swap, so wait for room first.
    waited = 0
    while free_gb() < 2.6 and waited < 3 * 3600:
        if waited % 300 == 0:
            print(f"waiting for memory: {free_gb():.1f} GB free", flush=True)
        time.sleep(20)
        waited += 20

    import torch
    import torchaudio
    from chatterbox.tts import ChatterboxTTS

    torch.set_num_threads(int(os.environ.get("VOICE_THREADS", "5")))
    t0 = time.time()
    model = ChatterboxTTS.from_pretrained(device="cpu")
    print(f"model loaded in {time.time() - t0:.0f}s", flush=True)
    for line in todo:
        index = next(i for i, l in enumerate(lines) if l["id"] == line["id"])
        torch.manual_seed(2000 + index + seed_offset)
        t0 = time.time()
        with torch.inference_mode():
            wav = model.generate(line["tts"], exaggeration=line["ex"], cfg_weight=line["cfg"], temperature=0.8)
        torchaudio.save(os.path.join(OUT, f"{line['id']}.wav"), wav.cpu(), model.sr)
        print(f"{line['id']} {wav.shape[-1] / model.sr:5.2f}s of audio in {time.time() - t0:4.0f}s  {line['tts'][:60]}", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
