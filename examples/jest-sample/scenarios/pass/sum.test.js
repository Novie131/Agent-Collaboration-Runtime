const { sum } = require('../../src/math');

describe('sum', () => {
  const cases = Array.from({ length: 60 }, (_, i) => [i, i + 1, 2 * i + 1]);
  test.each(cases)('sum(%i, %i) === %i', (a, b, expected) => {
    expect(sum(a, b)).toBe(expected);
  });
});
