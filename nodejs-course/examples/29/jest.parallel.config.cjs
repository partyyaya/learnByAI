module.exports = {
  ...require('./jest.config.cjs'),
  testMatch: ['**/parallel-alpha.test.js', '**/parallel-beta.test.js'],
};
