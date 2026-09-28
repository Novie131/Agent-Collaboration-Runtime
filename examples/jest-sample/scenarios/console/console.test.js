const { sum } = require('../../src/math');

test('logs and warns', () => {
  console.log('custom log line — 日本語 ✓');
  console.warn('DeprecationWarning: this API will be removed');
  console.error('something looked wrong but the test continues');
  expect(sum(1, 1)).toBe(2);
});

test.each(Array.from({ length: 30 }, (_, i) => [i]))('quiet case %i', (i) => {
  expect(sum(i, 1)).toBe(i + 1);
});
