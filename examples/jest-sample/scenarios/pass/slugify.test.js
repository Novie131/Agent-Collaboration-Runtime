const { slugify } = require('../../src/math');

describe('slugify', () => {
  describe('ascii', () => {
    test.each([
      ['Hello World', 'hello-world'],
      ['  trim me  ', 'trim-me'],
      ['a--b', 'a-b'],
      ['CamelCase', 'camelcase'],
      ['123 go', '123-go'],
    ])('%s', (input, expected) => {
      expect(slugify(input)).toBe(expected);
    });
  });
  describe('accents', () => {
    test.each([
      ['Crème brûlée', 'creme-brulee'],
      ['Ångström', 'angstrom'],
      ['naïve café', 'naive-cafe'],
    ])('%s', (input, expected) => {
      expect(slugify(input)).toBe(expected);
    });
  });
});
