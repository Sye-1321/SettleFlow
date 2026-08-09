import { Injectable } from '@nestjs/common';
import type { WebhookProjectionConsumerSignal } from '@settleflow/eventing';
import { TelemetryRuntime } from '@settleflow/infrastructure';

@Injectable()
export class WebhookProjectionSignalService {
  public constructor(private readonly telemetry: TelemetryRuntime) {}

  public record(signal: WebhookProjectionConsumerSignal): void {
    this.telemetry.logger.record('info', signal);
  }
}
