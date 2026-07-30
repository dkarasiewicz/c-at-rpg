import js from "@eslint/js";
import prettier from "eslint-plugin-prettier/recommended";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      prettier,
    ],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {},
  },
  // ARCHITECTURE.md §0 layering: src/core and src/content are pure logic/data —
  // pixi.js (and any of its subpaths) must never be imported there.
  {
    files: ["src/core/**/*.{ts,tsx}", "src/content/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["pixi.js", "pixi.js/*"],
              message:
                "src/core and src/content must stay pixi-free (ARCHITECTURE.md §0).",
            },
          ],
        },
      ],
    },
  },
);
