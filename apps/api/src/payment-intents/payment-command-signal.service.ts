import { Injectable, Logger } from '@nestjs/common';
import type { PaymentCommandObservation, PaymentCommandObserver } from '@settleflow/payments';

@Injectable()
export class PaymentCommandSignalService implements PaymentCommandObserver {
  private readonly logger = new Logger(PaymentCommandSignalService.name);

  public record(observation: PaymentCommandObservation): void {
    this.logger.log(JSON.stringify({ event: 'payment.command', ...observation }));
  }
}
