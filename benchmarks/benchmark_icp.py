#!/usr/bin/env python3
"""
benchmark_icp.py
================
Reproduces Table IV of the companion IEEE RA-L paper.

Evaluates the 2-D ICP alignment routine on 5 synthetic indoor-environment
occupancy-map pairs at 4 initial-pose-error levels (n=25 trials each),
computing rotation RMSE (degrees), translation RMSE (metres), and
convergence success rate.

The ICP algorithm mirrors the JavaScript implementation in script.js:
  - Stride-3 wall-pixel subsampling.
  - Uniform 2-D spatial hash (cell size = 15 px) for nearest-neighbour queries.
  - Up to 25 Procrustes iterations (Arun et al., 1987 closed-form solution).
  - Convergence criterion: < 10 valid correspondences.

Run
---
  python3 benchmark_icp.py

Requirements
------------
  numpy  (pip install numpy)
  Maps must already be generated:  python3 generate_synthetic_maps.py
"""

import os
import csv
import math
import numpy as np

RNG          = np.random.default_rng(seed=42)
N_MAPS       = 5
TRIALS       = 25
MAP_RES_M    = 0.05    # metres per pixel (as stated in paper)
CELL_SIZE    = 15      # spatial hash cell size (pixels)
MAX_ITERS    = 25
MIN_CORR     = 10      # < MIN_CORR correspondences → diverged

ERROR_LEVELS = [
    dict(label="±5°, ±0.05m",   rot_deg=5,  trans_m=0.05),
    dict(label="±15°, ±0.20m",  rot_deg=15, trans_m=0.20),
    dict(label="±30°, ±0.50m",  rot_deg=30, trans_m=0.50),
    dict(label="±45°, ±1.00m",  rot_deg=45, trans_m=1.00),
]

# ---------------------------------------------------------------------------
def read_pgm(path: str) -> np.ndarray:
    with open(path, "rb") as f:
        raw = f.read()
    lines = []
    i = 0
    while len(lines) < 3:
        end = raw.index(b"\n", i)
        line = raw[i:end].decode().strip()
        if not line.startswith("#"):
            lines.append(line)
        i = end + 1
    w, h = map(int, lines[1].split())
    i += 1  # skip maxval line's newline
    return np.frombuffer(raw[i:], dtype=np.uint8).reshape(h, w)

def extract_wall_pts(grid: np.ndarray, stride: int = 3) -> np.ndarray:
    """Return Nx2 array of (x, y) wall-pixel coordinates (stride-3 subsampled)."""
    rows, cols = np.where(grid[::stride, ::stride] == 0)
    return np.stack([cols * stride, rows * stride], axis=1).astype(float)

def build_spatial_hash(pts: np.ndarray, cell: int) -> dict:
    h = {}
    for p in pts:
        key = (int(p[0] // cell), int(p[1] // cell))
        h.setdefault(key, []).append(p)
    return h

def nearest_in_hash(query: np.ndarray, h: dict, cell: int):
    cx, cy = int(query[0] // cell), int(query[1] // cell)
    best_d, best_p = float("inf"), None
    for dx in range(-1, 2):
        for dy in range(-1, 2):
            for p in h.get((cx + dx, cy + dy), []):
                d = float(np.sum((query - p) ** 2))
                if d < best_d:
                    best_d, best_p = d, p
    return best_p, math.sqrt(best_d)

def apply_transform(pts: np.ndarray, theta: float, tx: float, ty: float) -> np.ndarray:
    c, s = math.cos(theta), math.sin(theta)
    R = np.array([[c, -s], [s, c]])
    return (R @ pts.T).T + np.array([tx, ty])

def procrustes_2d(src: np.ndarray, dst: np.ndarray):
    """Closed-form 2-D rigid transform from matched point sets (Arun et al., 1987)."""
    cs = src.mean(axis=0)
    cd = dst.mean(axis=0)
    A  = ((dst - cd).T @ (src - cs))
    U, _, Vt = np.linalg.svd(A)
    d  = np.linalg.det(U @ Vt)
    R  = U @ np.diag([1, d]) @ Vt
    theta = math.atan2(R[1, 0], R[0, 0])
    t = cd - R @ cs
    return theta, t[0], t[1]

def run_icp(source_pts: np.ndarray, target_pts: np.ndarray,
            init_theta: float, init_tx: float, init_ty: float):
    theta, tx, ty = init_theta, init_tx, init_ty
    h = build_spatial_hash(target_pts, CELL_SIZE)

    for _ in range(MAX_ITERS):
        transformed = apply_transform(source_pts, theta, tx, ty)
        src_m, dst_m = [], []
        for tp in transformed:
            nn, _ = nearest_in_hash(tp, h, CELL_SIZE)
            if nn is not None:
                src_m.append(tp)
                dst_m.append(nn)
        if len(src_m) < MIN_CORR:
            return None   # diverged
        theta, tx, ty = procrustes_2d(np.array(src_m), np.array(dst_m))

    return theta, tx, ty

# ---------------------------------------------------------------------------
os.makedirs("results", exist_ok=True)
rows = []

header = f"{'Level':<20}  {'Success':>7}  {'RotRMSE(°)':>11}  {'TransRMSE(m)':>13}"
print(header)
print("-" * len(header))

for el in ERROR_LEVELS:
    success_count = 0
    rot_errs, trans_errs = [], []

    for map_i in range(N_MAPS):
        path = f"maps/icp/base_{map_i}.pgm"
        if not os.path.exists(path):
            raise FileNotFoundError(f"{path} not found — run generate_synthetic_maps.py first")
        base = read_pgm(path)
        target_pts = extract_wall_pts(base)

        for trial in range(TRIALS):
            # Ground-truth perturbation
            gt_rot = RNG.uniform(-el["rot_deg"],   el["rot_deg"])   * math.pi / 180
            gt_tx  = RNG.uniform(-el["trans_m"],   el["trans_m"])   / MAP_RES_M
            gt_ty  = RNG.uniform(-el["trans_m"],   el["trans_m"])   / MAP_RES_M

            source_pts = extract_wall_pts(base)
            source_pts_perturbed = apply_transform(source_pts, gt_rot, gt_tx, gt_ty)

            # Start ICP from zero init
            result = run_icp(source_pts_perturbed, target_pts, 0.0, 0.0, 0.0)
            if result is None:
                continue

            est_rot, est_tx, est_ty = result

            # Compute errors
            rot_err_deg  = abs((gt_rot - est_rot) * 180 / math.pi)
            rot_err_deg  = min(rot_err_deg, 360 - rot_err_deg)
            trans_err_m  = math.hypot((gt_tx - est_tx) * MAP_RES_M,
                                       (gt_ty - est_ty) * MAP_RES_M)

            # Success if within 2× the initial error range
            tol_rot   = el["rot_deg"] * 2
            tol_trans = el["trans_m"] * 2
            if rot_err_deg <= tol_rot and trans_err_m <= tol_trans:
                success_count += 1
            rot_errs.append(rot_err_deg)
            trans_errs.append(trans_err_m)

    total_trials = N_MAPS * TRIALS
    pct = 100 * success_count / total_trials
    rot_rmse   = float(np.sqrt(np.mean(np.array(rot_errs)   ** 2))) if rot_errs   else float("nan")
    trans_rmse = float(np.sqrt(np.mean(np.array(trans_errs) ** 2))) if trans_errs else float("nan")

    print(f"{el['label']:<20}  {pct:>6.0f}%  {rot_rmse:>11.1f}°  {trans_rmse:>12.3f}m")
    rows.append({
        "initial_error":    el["label"],
        "success_pct":      round(pct, 1),
        "rot_rmse_deg":     round(rot_rmse,   2),
        "trans_rmse_m":     round(trans_rmse, 4),
        "n_trials":         total_trials,
    })

with open("results/icp_results.csv", "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["initial_error", "success_pct",
                                       "rot_rmse_deg", "trans_rmse_m", "n_trials"])
    w.writeheader()
    w.writerows(rows)

print("\nResults written to results/icp_results.csv")
