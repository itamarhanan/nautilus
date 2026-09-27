import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next*/**",
      "**/target/**",
      "**/src-tauri/gen/**",
      "**/src-tauri/binaries/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/dist/**",

      "**/public/**/*.js",

      "**/postcss.config.mjs",
    ],
  },
  js.configs.recommended,
  {
    name: "nautilus/typescript",
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "separate-type-imports",
          prefer: "type-imports",
        },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      eqeqeq: ["error", "always"],
      "no-console": "error",
      "no-implicit-coercion": "error",
      "no-implicit-globals": "error",
      "no-return-await": "error",
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    name: "nautilus/scripts",
    files: ["**/scripts/**", "**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    name: "nautilus/web",
    files: ["apps/web/**/*.{ts,tsx}"],
    extends: [next.configs["core-web-vitals"]],
    rules: {
      "@next/next/no-html-link-for-pages": ["error", "apps/web"],
    },
  },
);
