import typescriptEslint from '@typescript-eslint/eslint-plugin';
import header from 'eslint-plugin-header';
import jestFormatting from 'eslint-plugin-jest-formatting';
import prettier from 'eslint-plugin-prettier';
import unicorn from 'eslint-plugin-unicorn';
import tsParser from '@typescript-eslint/parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// workaround: https://github.com/Stuk/eslint-plugin-header/issues/57#issuecomment-2378485611
header.rules.header.meta.schema = false;
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

export default [
  ...compat.extends(
    'eslint:recommended',
    'plugin:@typescript-eslint/eslint-recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ),
  {
    plugins: {
      '@typescript-eslint': typescriptEslint,
      header,
      'jest-formatting': jestFormatting,
      prettier,
      unicorn,
    },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',

      parserOptions: {
        project: 'tsconfig.json',
      },
    },

    rules: {
      '@typescript-eslint/no-explicit-any': ['off'],
      '@typescript-eslint/no-unused-vars': ['off'],

      '@typescript-eslint/strict-boolean-expressions': [
        2,
        {
          allowNullableObject: true,
          allowNullableBoolean: true,
          allowAny: true,
        },
      ],

      eqeqeq: ['error', 'smart'],
      'jest-formatting/padding-around-describe-blocks': 2,
      'jest-formatting/padding-around-test-blocks': 2,
      'header/header': [2, './resources/license.header.js'],
      'mocha/max-top-level-suites': 'off',
      'mocha/no-exports': 'off',
      'mocha/no-mocha-arrows': 'off',
      'no-console': 0,
      'no-return-await': 2,
      'no-unneeded-ternary': 2,
      'no-unused-vars': 'off',

      'prettier/prettier': [
        'error',
        {
          endOfLine: 'auto',
        },
      ],

      'unicorn/prefer-node-protocol': 2,
    },
  },
];
