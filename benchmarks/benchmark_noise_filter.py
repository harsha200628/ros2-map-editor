#!/usr/bin/env python3
"""
benchmark_noise_filter.py
=========================
Reproduces Table III of the companion IEEE RA-L paper.

Applies two de-noising methods to 10 synthetic noise-corrupted occupancy maps
at three noise levels (1 %, 3 %, 5 %), computes pixel-level F1 against
ground truth, and writes results/noise_filter_results.csv.

Methods compared
----------------
  no_filter  : raw noisy map (baseline)
  median     : scipy.ndimage.median_filter(size=3) clamped to {0,205,254}
  majority   : class-aware 8-neighbourhood majority-vote filter (the proposed
               algorithm from Section IV-B of the paper)

Run
---
  python3 benchmark_noise_filter.py

Requirements
------------
  numpy, scipy, scikit-learn  (pip install numpy scipy scikit-learn)
  Maps must already be generated:  python3 generate_synthetic_maps.py
"""

import os
import csv
import numpy as np
from scipy.ndimage import median_filter
from sklearn.metrics import f1_score

NOISE_LEVELS = [1, 3, 5]
N_MAPS       = 10
TRINARY      = np.array([0, 205, 254], dtype=np.uint8)

# ---------------------------------------------------------------------------
def read_pgm(path: str) -> np.ndarray:
    with open(path, "rb") as f:
        raw = f.read()
    lines = []
    i = 0
    while len(lines) < 4:
        end = raw.index(b"\n", i)
        line = raw[i:end].decode().strip()
        if not line.startswith("#"):
            lines.append(line)
        i = end + 1
    magic, wh, mv = lines[0], lines[1], lines[2]
    assert magic == "P5", "Only P5 PGM supported"
    w, h = map(int, wh.split())
    data = np.frombuffer(raw[i:], dtype=np.uint8).reshape(h, w)
    return data

def clamp_trinary(arr: np.ndarray) -> np.ndarray:
    """Map each pixel to the nearest value in {0, 205, 254}."""
    out = np.empty_like(arr)
    for v in TRINARY:
        out[np.abs(arr.astype(int) - int(v)) <= np.abs(arr.astype(int) - out.astype(int))] = v
    # simpler: nearest-neighbour
    dist = np.stack([np.abs(arr.astype(int) - int(v)) for v in TRINARY], axis=-1)
    return TRINARY[np.argmin(dist, axis=-1)].astype(np.uint8)

def majority_vote_filter(grid: np.ndarray) -> np.ndarray:
    """
    Class-aware 8-neighbourhood majority-vote filter (proposed algorithm).
    Unknown pixels (205) are skipped.
    """
    H, W = grid.shape
    src = grid.copy()
    dst = grid.copy()
    for y in range(1, H - 1):
        for x in range(1, W - 1):
            v = src[y, x]
            if v == 205:
                continue  # preserve unknown-space boundaries
            neighbours = src[y-1:y+2, x-1:x+2].flatten()
            neighbours = neighbours[neighbours != src[y, x]]  # exclude centre
            # count neighbours (8 total, centre excluded via slice then filter)
            nb = src[y-1:y+2, x-1:x+2]
            c254 = int(np.sum(nb == 254)) - (1 if v == 254 else 0)
            c0   = int(np.sum(nb == 0))   - (1 if v == 0   else 0)
            if v == 0   and c254 >= 5:
                dst[y, x] = 254
            elif v == 254 and c0   >= 5:
                dst[y, x] = 0
    return dst

def apply_median(grid: np.ndarray) -> np.ndarray:
    filtered = median_filter(grid.astype(int), size=3).astype(np.uint8)
    return clamp_trinary(filtered)

def pixel_f1(pred: np.ndarray, gt: np.ndarray) -> float:
    """Macro-average F1 over the trinary classes {0, 205, 254}."""
    return f1_score(gt.flatten(), pred.flatten(),
                    labels=[0, 205, 254], average="macro", zero_division=0)

# ---------------------------------------------------------------------------
os.makedirs("results", exist_ok=True)
rows = []
print(f"{'Map':>4}  {'Level':>5}  {'no_filter':>10}  {'median':>8}  {'majority':>10}")
print("-" * 50)

for i in range(N_MAPS):
    gt_path = f"maps/noise/gt_{i}.pgm"
    if not os.path.exists(gt_path):
        raise FileNotFoundError(f"{gt_path} not found — run generate_synthetic_maps.py first")
    gt = read_pgm(gt_path)

    for lvl in NOISE_LEVELS:
        noisy  = read_pgm(f"maps/noise/noisy_{i}_{lvl}.pgm")
        med    = apply_median(noisy)
        maj    = majority_vote_filter(noisy)

        f1_no  = pixel_f1(noisy, gt)
        f1_med = pixel_f1(med,   gt)
        f1_maj = pixel_f1(maj,   gt)

        rows.append({"map": i, "noise_pct": lvl,
                     "no_filter": round(f1_no,  4),
                     "median":    round(f1_med, 4),
                     "majority":  round(f1_maj, 4)})
        print(f"{i:>4}  {lvl:>4}%  {f1_no:>10.4f}  {f1_med:>8.4f}  {f1_maj:>10.4f}")

# Summary per noise level
print("\nMean F1 per noise level:")
for lvl in NOISE_LEVELS:
    subset = [r for r in rows if r["noise_pct"] == lvl]
    print(f"  {lvl}%  no_filter={np.mean([r['no_filter'] for r in subset]):.3f}  "
          f"median={np.mean([r['median'] for r in subset]):.3f}  "
          f"majority={np.mean([r['majority'] for r in subset]):.3f}")

with open("results/noise_filter_results.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["map", "noise_pct", "no_filter", "median", "majority"])
    w.writeheader()
    w.writerows(rows)

print("\nResults written to results/noise_filter_results.csv")
