/**
 * Statistics used by `compare`. Methods are fixed in the experiment's stats
 * plan before results are seen. When a method's preconditions are not met the
 * functions return null with a reason instead of inventing an interval.
 */

export const Z_ONE_SIDED_95 = 1.6448536269514722;

/**
 * Tango (1998) score statistic for the difference of paired proportions
 * Δ = p_treatment − p_baseline, with
 *   x12 = pairs where treatment passed and baseline failed,
 *   x21 = pairs where treatment failed and baseline passed.
 */
export function tangoScore(x12: number, x21: number, n: number, delta: number): number {
  const A = 2 * n;
  const B = -x12 - x21 + (2 * n - x12 + x21) * delta;
  const C = -x21 * delta * (1 - delta);
  const disc = Math.max(0, B * B - 4 * A * C);
  const q21 = (Math.sqrt(disc) - B) / (2 * A);
  const variance = n * (2 * q21 + delta * (1 - delta));
  const numerator = x12 - x21 - n * delta;
  if (variance <= 0) return numerator > 0 ? Number.POSITIVE_INFINITY : numerator < 0 ? Number.NEGATIVE_INFINITY : 0;
  return numerator / Math.sqrt(variance);
}

export interface PairedBinaryBound {
  n_pairs: number;
  treatment_only_pass: number;
  baseline_only_pass: number;
  both_pass: number;
  both_fail: number;
  observed_delta: number;
  lower_bound: number;
}

/** One-sided (1 − α) lower confidence bound for Δ by inverting the Tango score test. */
export function tangoLowerBound(pairs: { baseline: boolean; treatment: boolean }[], z = Z_ONE_SIDED_95): PairedBinaryBound | null {
  const n = pairs.length;
  if (n === 0) return null;
  const x12 = pairs.filter((p) => p.treatment && !p.baseline).length;
  const x21 = pairs.filter((p) => !p.treatment && p.baseline).length;
  const both = pairs.filter((p) => p.treatment && p.baseline).length;
  const observed = (x12 - x21) / n;
  let lo = -1 + 1e-12;
  let hi = observed;
  if (tangoScore(x12, x21, n, lo) < z) {
    return { n_pairs: n, treatment_only_pass: x12, baseline_only_pass: x21, both_pass: both, both_fail: n - x12 - x21 - both, observed_delta: observed, lower_bound: -1 };
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tangoScore(x12, x21, n, mid) >= z) lo = mid;
    else hi = mid;
  }
  return { n_pairs: n, treatment_only_pass: x12, baseline_only_pass: x21, both_pass: both, both_fail: n - x12 - x21 - both, observed_delta: observed, lower_bound: lo };
}

/** Deterministic PRNG so a registered seed reproduces the interval. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TaskTokens {
  task_id: string;
  baseline_mean: number;
  treatment_mean: number;
}

export interface BootstrapResult {
  iterations: number;
  lower_bound: number;
  distribution: { p05: number; p50: number; p95: number };
  skipped_resamples: number;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Percentile bootstrap over tasks (the cluster unit) for
 * reduction = 1 − Σ treatment / Σ baseline, using per-task means over repetitions.
 */
export function clusterBootstrapReduction(tasks: TaskTokens[], iterations: number, seed: number): BootstrapResult | null {
  if (tasks.length < 2) return null;
  const rand = mulberry32(seed);
  const stats: number[] = [];
  let skipped = 0;
  for (let i = 0; i < iterations; i++) {
    let a = 0;
    let b = 0;
    for (let k = 0; k < tasks.length; k++) {
      const t = tasks[Math.floor(rand() * tasks.length)]!;
      a += t.baseline_mean;
      b += t.treatment_mean;
    }
    if (a <= 0) {
      skipped++;
      continue;
    }
    stats.push(1 - b / a);
  }
  if (!stats.length) return null;
  stats.sort((x, y) => x - y);
  return {
    iterations,
    lower_bound: quantile(stats, 0.05),
    distribution: { p05: quantile(stats, 0.05), p50: quantile(stats, 0.5), p95: quantile(stats, 0.95) },
    skipped_resamples: skipped,
  };
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  return quantile([...xs].sort((a, b) => a - b), 0.5);
}
