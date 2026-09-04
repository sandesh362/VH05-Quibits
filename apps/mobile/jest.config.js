/**
 * Jest (jest-expo) configuration for the mobile app.
 *
 * jest-expo is Expo's supported test preset: it provides the React Native
 * mock, the RN transform for node_modules, and asset stubbing, so component
 * tests run in plain Node/Expo Go-compatible fashion without any native
 * build. Pure logic suites (API client, outbox, sync) use the same preset.
 */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/src/**/*.test.@(ts|tsx)'],
  setupFiles: ['./src/test/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // @itp/shared is ESM-only ("exports" lacks a "require" condition); map to
    // its TypeScript source and let babel-jest transform it to CJS.
    '^@itp/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(jest-)?react-native|@react-native(-community)?|expo(nator)?|@expo(?:nge)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg|react-native-reanimated|react-native-worklets)',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/test/**'],
};
