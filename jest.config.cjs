const common = {
  clearMocks: true,
  collectCoverageFrom: ['<rootDir>/apps/**/*.ts', '!<rootDir>/apps/**/main.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@settleflow/infrastructure$': '<rootDir>/packages/infrastructure/src/index.ts',
    '^@settleflow/merchant-access$': '<rootDir>/packages/modules/merchant-access/src/index.ts',
    '^@settleflow/idempotency$': '<rootDir>/packages/modules/idempotency/src/index.ts',
    '^@settleflow/eventing$': '<rootDir>/packages/modules/eventing/src/index.ts',
    '^@settleflow/payments$': '<rootDir>/packages/modules/payments/src/index.ts',
    '^@settleflow/operations$': '<rootDir>/packages/modules/operations/src/index.ts',
    '^@settleflow/webhooks$': '<rootDir>/packages/modules/webhooks/src/index.ts',
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
      collectCoverageFrom: ['<rootDir>/packages/modules/idempotency/src/**/*.ts'],
      displayName: 'idempotency',
      testMatch: ['<rootDir>/packages/modules/idempotency/src/**/*.spec.ts'],
    },
    {
      ...common,
      collectCoverageFrom: ['<rootDir>/packages/modules/eventing/src/**/*.ts'],
      displayName: 'eventing',
      testMatch: ['<rootDir>/packages/modules/eventing/src/**/*.spec.ts'],
    },
    {
      ...common,
      collectCoverageFrom: ['<rootDir>/packages/modules/payments/src/**/*.ts'],
      displayName: 'payments',
      testMatch: ['<rootDir>/packages/modules/payments/src/**/*.spec.ts'],
    },
    {
      ...common,
      collectCoverageFrom: ['<rootDir>/packages/modules/operations/src/**/*.ts'],
      displayName: 'operations',
      testMatch: ['<rootDir>/packages/modules/operations/src/**/*.spec.ts'],
    },
    {
      ...common,
      collectCoverageFrom: ['<rootDir>/packages/modules/webhooks/src/**/*.ts'],
      displayName: 'webhooks',
      testMatch: ['<rootDir>/packages/modules/webhooks/src/**/*.spec.ts'],
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.int-spec.ts'],
      testTimeout: 120_000,
    },
  ],
};
