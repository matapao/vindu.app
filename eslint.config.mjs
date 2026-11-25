import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  globalIgnores(['**/dist/', '**/out/']),
  js.configs.recommended,
  {
    files: ['eslint.config.mjs', '{scripts,test,frame/scripts,frame/test}/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.nodeBuiltin },
  },
]);
