"""Print the frame file on screen at a shot's mark (plus seconds): python demo/peek.py round3 cover+1"""
import bisect, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
shot, spec = sys.argv[1], sys.argv[2]
d = json.load(open(os.path.join(HERE, "out", "shots", shot, "frames.json")))
name, off = spec, 0.0
for s in "+-":
    k = spec.rfind(s)
    if k > 0:
        try:
            off = float(spec[k:]); name = spec[:k]; break
        except ValueError:
            pass
t = d["marks"][name] + off
times = [f["t"] for f in d["frames"]]
i = max(0, bisect.bisect_right(times, t) - 1)
print(os.path.join(HERE, "out", "shots", shot, d["frames"][i]["file"]))
