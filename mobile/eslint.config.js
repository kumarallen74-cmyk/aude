// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'node_modules/*', '.expo/*', 'ios/*', 'android/*', 'coverage/*'],
  },
  {
    files: ['plugins/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js', 'jest.setup.ts'],
    languageOptions: { globals: { require: 'readonly', module: 'writable', __dirname: 'readonly', process: 'readonly', console: 'readonly' } },
  },
  {
    files: ['**/__tests__/**', 'src/test/**', 'jest.setup.ts'],
    rules: { '@typescript-eslint/no-require-imports': 'off', 'import/first': 'off' },
  },
]);
