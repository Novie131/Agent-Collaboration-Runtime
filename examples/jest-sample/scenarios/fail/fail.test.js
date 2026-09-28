const { sum, slugify } = require('../../src/math');

describe('intentional failures', () => {
  test('number mismatch', () => {
    expect(sum(1, 1)).toBe(3);
  });

  test('object diff', () => {
    expect({ id: 1, name: 'Ada', tags: ['x', 'y'] }).toEqual({ id: 1, name: 'Ada Lovelace', tags: ['x', 'z'] });
  });

  test('unicode multi-line string diff', () => {
    expect(`第一行\n${slugify('Crème')}\nlast ✓`).toBe('第一行\ncreme-brulee\nlast ✓');
  });

  test('thrown error with stack', () => {
    function deep() {
      throw new TypeError('cannot read property "x" of undefined (simulated)');
    }
    deep();
  });

  test('still passes', () => {
    expect(sum(2, 2)).toBe(4);
  });
});
