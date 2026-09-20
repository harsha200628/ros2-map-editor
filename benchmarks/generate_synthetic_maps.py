"""
generate_synthetic_maps.py
==========================
Generates all synthetic PGM occupancy-grid maps used in the benchmarks.

Maps produced
-------------
Latency benchmark (Table II):
  maps/small_512.pgm      512  x 512  px
  maps/medium_1024.pgm   1024  x 1024 px
  maps/large_2048.pgm    2048  x 2048 px

Noise-filter benchmark (Table III):
  maps/noise/gt_{i}.pgm              ground-truth map (i = 0..9)
  maps/noise/noisy_{i}_{level}.pgm   corrupted at level in {1, 3, 5} %

ICP benchmark (Table IV):
  maps/icp/base_{i}.pgm              base map (i = 0..4)
  maps/icp/source_{i}.pgm            source map (same as base; transforms applied at runtime)

All maps are P5 (binary) PGM with maxVal=255, trinary alphabet {0, 205, 254}.
Random seed: 42 (fully deterministic).
"""

import os
import struct
import numpy as np

RNG = np.random.default_rng(seed=42)
os.makedirs("maps/noise", exist_ok=True)
os.makedirs("maps/icp", exist_ok=True)

# ---------------------------------------------------------------------------
# PGM writer
# ---------------------------------------------------------------------------
def write_pgm(path: str, arr: np.ndarray) -> None:
    """Write a 2-D uint8 array as a P5 (binary) PGM file."""
    h, w = arr.shape
    header = f"P5\n# 2D Occupancy Grid Map Editor benchmark\n{w} {h}\n255\n".encode()
    with open(path, "wb") as f:
        f.write(header)
        f.write(arr.astype(np.uint8).tobytes())

# ---------------------------------------------------------------------------
# Synthetic map generator
# ---------------------------------------------------------------------------
def make_indoor_map(width: int, height: int, seed_offset: int = 0) -> np.ndarray:
    """
    Synthesise a plausible indoor occupancy grid.

    Strategy:
      1. Start with a free-space canvas (254).
      2. Draw random axis-aligned room walls (double-pixel walls).
      3. Punch doorways in each internal wall.
      4. Add a border wall.
      5. Scatter unknown-space blobs.
    """
    rng = np.random.default_rng(seed=42 + seed_offset)
    grid = np.full((height, width), 254, dtype=np.uint8)

    # Outer border
    grid[0, :]  = 0
    grid[-1, :] = 0
    grid[:, 0]  = 0
    grid[:, -1] = 0

    # Internal walls (horizontal + vertical room dividers)
    n_h = rng.integers(2, max(3, height // 120) + 1)
    n_v = rng.integers(2, max(3, width  // 120) + 1)

    h_walls = sorted(rng.integers(width  // 8, 7 * width  // 8, size=n_v).tolist())
    v_walls = sorted(rng.integers(height // 8, 7 * height // 8, size=n_h).tolist())

    for x in h_walls:
        grid[:, x]     = 0
        if x + 1 < width:
            grid[:, x + 1] = 0
        # Doorway
        door_y = rng.integers(4, height - 4)
        door_w = rng.integers(8, 20)
        y0 = max(1, door_y - door_w // 2)
        y1 = min(height - 2, door_y + door_w // 2)
        grid[y0:y1, x]     = 254
        if x + 1 < width:
            grid[y0:y1, x + 1] = 254

    for y in v_walls:
        grid[y, :]     = 0
        if y + 1 < height:
            grid[y + 1, :] = 0
        # Doorway
        door_x = rng.integers(4, width - 4)
        door_w = rng.integers(8, 20)
        x0 = max(1, door_x - door_w // 2)
        x1 = min(width - 2, door_x + door_w // 2)
        grid[y, x0:x1]     = 254
        if y + 1 < height:
            grid[y + 1, x0:x1] = 254

    # Unknown-space blobs (simulate unvisited corners)
    n_blobs = rng.integers(3, 8)
    for _ in range(n_blobs):
        bx = rng.integers(2, width  - 2)
        by = rng.integers(2, height - 2)
        br = rng.integers(4, min(30, width // 20))
        yy, xx = np.ogrid[-by:height - by, -bx:width - bx]
        mask = (xx ** 2 + yy ** 2) <= br ** 2
        grid[mask & (grid == 254)] = 205

    return grid

# ---------------------------------------------------------------------------
# 1. Latency benchmark maps
# ---------------------------------------------------------------------------
print("Generating latency benchmark maps …")
for label, (w, h) in [("small_512", (512, 512)),
                       ("medium_1024", (1024, 1024)),
                       ("large_2048", (2048, 2048))]:
    m = make_indoor_map(w, h)
    write_pgm(f"maps/{label}.pgm", m)
    print(f"  maps/{label}.pgm  ({w}×{h})")

# ---------------------------------------------------------------------------
# 2. Noise-filter benchmark maps (10 ground-truth maps × 3 noise levels)
# ---------------------------------------------------------------------------
print("\nGenerating noise-filter benchmark maps …")
NOISE_LEVELS = [1, 3, 5]   # percent

for i in range(10):
    gt = make_indoor_map(512, 512, seed_offset=100 + i)
    write_pgm(f"maps/noise/gt_{i}.pgm", gt)

    for lvl in NOISE_LEVELS:
        noisy = gt.copy()
        n_pixels = int(512 * 512 * lvl / 100)
        # Salt (random wall pixels in free space)
        free_idx = np.argwhere(noisy == 254)
        if len(free_idx) > 0:
            chosen = free_idx[RNG.choice(len(free_idx),
                                         size=min(n_pixels // 2, len(free_idx)),
                                         replace=False)]
            noisy[chosen[:, 0], chosen[:, 1]] = 0
        # Pepper (random free pixels in wall space)
        wall_idx = np.argwhere(noisy == 0)
        if len(wall_idx) > 0:
            chosen = wall_idx[RNG.choice(len(wall_idx),
                                          size=min(n_pixels // 2, len(wall_idx)),
                                          replace=False)]
            noisy[chosen[:, 0], chosen[:, 1]] = 254
        write_pgm(f"maps/noise/noisy_{i}_{lvl}.pgm", noisy)

    print(f"  maps/noise/gt_{i}.pgm  + noisy variants")

# ---------------------------------------------------------------------------
# 3. ICP benchmark maps (5 indoor maps as base; transforms applied at runtime)
# ---------------------------------------------------------------------------
print("\nGenerating ICP benchmark maps …")
for i in range(5):
    base = make_indoor_map(512, 512, seed_offset=200 + i)
    write_pgm(f"maps/icp/base_{i}.pgm", base)
    print(f"  maps/icp/base_{i}.pgm")

print("\nDone. All maps written to maps/")
