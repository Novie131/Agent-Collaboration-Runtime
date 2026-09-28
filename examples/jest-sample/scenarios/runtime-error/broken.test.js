const missing = require('./does-not-exist');

test('never reached', () => {
  expect(missing).toBeDefined();
});
