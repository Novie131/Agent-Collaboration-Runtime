const { sum, slugify } = require('../../src/math');

describe('mixed statuses', () => {
  test('passes', () => {
    expect(sum(1, 2)).toBe(3);
  });

  test.skip('skipped on purpose', () => {
    expect(true).toBe(false);
  });

  test.todo('write a test for negative numbers');

  test('matches inline snapshot', () => {
    expect(slugify('Snapshot Test')).toMatchInlineSnapshot(`"snapshot-test"`);
  });

  test('matches file snapshot', () => {
    expect({ a: 1, b: [1, 2, 3] }).toMatchSnapshot();
  });
});

describe.skip('skipped block', () => {
  test('never runs', () => {
    expect(1).toBe(2);
  });
});
