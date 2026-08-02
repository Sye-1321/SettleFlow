import { Injectable, Logger } from '@nestjs/common';
import type { WebhookDeliverySignal } from '@settleflow/webhooks';

@Injectable()
export class WebhookDeliverySignalService {
  private readonly logger = new Logger(WebhookDeliverySignalService.name);

  public record(signal: WebhookDeliverySignal): void {
    this.logger.log(JSON.stringify(signal));
  }
}
