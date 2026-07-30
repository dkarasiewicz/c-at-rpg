/**
 * Minimal Node ambient for the api/ package — keeps @types/node out of the
 * workspace so the app's global type surface (root tsconfig) is untouched.
 * Vercel's Node runtime provides the real `process`.
 */
declare const process: {
  env: Record<string, string | undefined>;
};
