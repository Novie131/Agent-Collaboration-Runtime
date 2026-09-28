const { sum } = require('../../src/math');

test.each(Array.from({ length: 40 }, (_, i) => [i]))('sum(%i, 0) is identity', (i) => {
  expect(sum(i, 0)).toBe(i);
});

test('off by one', () => {
  expect(sum(10, 10)).toBe(21);
});
