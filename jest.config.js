require('ts-node/register')
require('tsconfig-paths/register')

module.exports = {
  preset: 'ts-jest',
  testTimeout: 10000,
  moduleFileExtensions: ['js', 'jsx', 'json', 'ts', 'tsx'],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.(js|ts)x?$',
  testPathIgnorePatterns: ['/node_modules/', '/build/', '/coverage/', '/lib/'],
  rootDir: './',
}
