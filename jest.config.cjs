const common = {
  clearMocks: true,
  collectCoverageFrom: ['<rootDir>/apps/**/*.ts', '!<rootDir>/apps/**/main.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@settleflow/infrastructure$': '<rootDir>/packages/infrastructure/src/index.ts',
    '^@settleflow/merchant-access$': '<rootDir>/packages/modules/merchant-access/src/index.ts',
  },
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
    {
      ...common,
      collectCoverageFrom: ['<rootDir>/packages/modules/merchant-access/src/**/*.ts'],
      displayName: 'merchant-access',
      testMatch: ['<rootDir>/packages/modules/merchant-access/src/**/*.spec.ts'],
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
      testTimeout: 120_000,
    },
  ],
};
