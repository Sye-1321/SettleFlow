import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const configuration = new DocumentBuilder()
    .setTitle('SettleFlow API')
    .setDescription(
      'Finance-grade payment-platform simulation. Merchant API routes use scoped API keys; no real funds or regulated payment data are supported.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        bearerFormat: 'SettleFlow merchant API key',
        description:
          'Use Authorization: Bearer <merchant_api_key>. Never place a real key in documentation.',
        scheme: 'bearer',
        type: 'http',
      },
      'merchantApiKey',
    )
    .build();

  return SwaggerModule.createDocument(app, configuration, {
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey}.${methodKey}`,
  });
}

export function configureOpenApi(app: INestApplication): void {
  SwaggerModule.setup('docs', app, () => createOpenApiDocument(app), {
    jsonDocumentUrl: 'docs/openapi.json',
    raw: ['json'],
    ui: true,
  });
}
