import { Injectable } from '@nestjs/common';
import { TelemetryRuntime } from '@settleflow/infrastructure';
import type { PaymentCommandObservation, PaymentCommandObserver } from '@settleflow/payments';

@Injectable()
export class PaymentCommandSignalService implements PaymentCommandObserver {
  public constructor(private readonly telemetry: TelemetryRuntime) {}

  public record(observation: PaymentCommandObservation): void {
    this.telemetry.logger.record('info', { event: 'payment.command', ...observation });
  }
}
