import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'

// Next.js 16 ships native ESLint 9 flat-config arrays. We use the standard
// `core-web-vitals` ruleset (React Hooks correctness, next-specific rules,
// a11y, import hygiene). `eslint-config-next/typescript` is intentionally NOT
// included yet — it flags every `any` and would drown the gate; adopt it
// incrementally later.
const eslintConfig = [
  {
    ignores: [
      // Root-relative, so this alone does NOT cover build output nested inside
      // agent worktrees — hence the two globs below it.
      '.next/**',
      // Build output anywhere (e.g. .claude/worktrees/<name>/.next/**). Without
      // this, a worktree that has been built leaks ~50 minified-bundle errors
      // into the lint gate and drowns real source findings.
      '**/.next/**',
      // Agent worktrees are throwaway checkouts of this same repo; linting them
      // double-reports every finding against a stale copy of the source.
      '.claude/**',
      'node_modules/**',
      'next-env.d.ts',
      'coverage/**',
      'public/**',
    ],
  },
  ...nextCoreWebVitals,
  {
    rules: {
      // The experimental React-Compiler-oriented react-hooks@7 rules are too
      // opinionated for this (non-compiler) codebase and flag many legitimate
      // patterns; disabling them beats refactoring ~110 call sites. The CRITICAL
      // hooks rule (react-hooks/rules-of-hooks) stays an error and currently has
      // ZERO violations, so it gates real hook misuse going forward.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/use-memo': 'off',
      // Cosmetic (apostrophes/quotes in JSX text render fine) — keep it visible
      // as a warning rather than gate on it.
      'react/no-unescaped-entities': 'warn',
    },
  },
]

export default eslintConfig
