const common = {
  clearMocks: true,
  collectCoverageFrom: ['<rootDir>/apps/**/*.ts', '!<rootDir>/apps/**/main.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.typecheck.json',
      },
    ],
  },
};

module.exports = {
  projects: [
    {
      ...common,
      displayName: 'api',
      testMatch: ['<rootDir>/apps/api/src/**/*.spec.ts'],
    },
    {
      ...common,
      displayName: 'worker',
      testMatch: ['<rootDir>/apps/worker/src/**/*.spec.ts'],
    },
  ],
};
