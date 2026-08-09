import { Injectable } from '@nestjs/common';
import type { WebhookDeliverySignal } from '@settleflow/webhooks';
import { TelemetryRuntime } from '@settleflow/infrastructure';

@Injectable()
export class WebhookDeliverySignalService {
  public constructor(private readonly telemetry: TelemetryRuntime) {}

  public record(signal: WebhookDeliverySignal): void {
    this.telemetry.logger.record('info', signal);
  }
}
