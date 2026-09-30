/**
 * Deterministic token estimator (SPEC §29.2). It is an estimate, never a measurement: every
 * stored estimate records ESTIMATOR_ID so numbers from different estimators are never mixed.
 * ASCII text averages about 4 characters per token; CJK and other non-ASCII characters are
 * counted as roughly one token each, which keeps Chinese text from being badly undercounted.
 */
export const ESTIMATOR_ID = 'mixed-chars-v1';

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

export const estimateJsonTokens = (value: unknown): number => estimateTokens(JSON.stringify(value) ?? '');
