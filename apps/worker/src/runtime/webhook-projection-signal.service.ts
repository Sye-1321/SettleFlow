import { Injectable, Logger } from '@nestjs/common';
import type { WebhookProjectionConsumerSignal } from '@settleflow/eventing';

@Injectable()
export class WebhookProjectionSignalService {
  private readonly logger = new Logger(WebhookProjectionSignalService.name);

  public record(signal: WebhookProjectionConsumerSignal): void {
    this.logger.log(JSON.stringify(signal));
  }
}
