import js from '@eslint/js'
import ts from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import globals from 'globals'

// Narrow, for the reason FamCart's config gives at length: vue-tsc already owns
// types, props, emits and template expressions, and tsconfig already has
// noUnusedLocals and noUnusedParameters, so anything here that re-checks those is
// duplicated work with two places to disagree.
//
// One rule differs from FamCart's, deliberately.
// `vue/no-bare-strings-in-template` is OFF here. FamCart has it as an error
// because every user-facing string in that app goes through t() and a bare word
// in a template is a missed translation. This dashboard is deliberately English
// only -- it has one reader, its vocabulary is the schema's ('household_id',
// 'source_version', 'security_events'), and half its copy quotes SQL. Turning the
// rule on would mean a catalog key per column header for no reader.
export default ts.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.vite/**'],
  },

  js.configs.recommended,
  ...ts.configs.recommended,
  ...vue.configs['flat/recommended'],

  {
    files: ['**/*.{js,mjs,ts,vue}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { parser: ts.parser },
    },
    rules: {
      // The two that catch real leftovers rather than style.
      'no-console': 'error',
      'no-debugger': 'error',

      // vue-tsc reports these with better messages and across templates.
      '@typescript-eslint/no-unused-vars': 'off',

      // `catch {}` with a comment saying why is the established idiom in both
      // repos -- storage that may be disabled, clipboard that may be refused.
      'no-empty': ['error', { allowEmptyCatch: true }],

      'vue/multi-word-component-names': 'off',

      // Formatting by another name. Same set FamCart turns off.
      'vue/attributes-order': 'off',
      'vue/html-self-closing': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/require-default-prop': 'off',

      // See the header: this tool speaks schema, not product copy.
      'vue/no-bare-strings-in-template': 'off',
    },
  },

  {
    // Node scripts, whose output IS the interface.
    files: ['scripts/**/*.mjs', '*.config.ts', '*.config.js'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  },

  {
    files: ['test/**/*.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // A test defines throwaway fixture components inline -- a child that
      // throws on render, a stub that records what it was passed. They are
      // fixtures, not components anyone imports, and splitting each into its
      // own file would scatter a test's setup away from its assertions.
      'vue/one-component-per-file': 'off',
    },
  },
)
