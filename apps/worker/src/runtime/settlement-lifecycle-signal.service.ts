import { Injectable, Logger } from '@nestjs/common';
import type { SettlementLifecycleConsumerSignal } from '@settleflow/eventing';

@Injectable()
export class SettlementLifecycleSignalService {
  private readonly logger = new Logger(SettlementLifecycleSignalService.name);

  public record(signal: SettlementLifecycleConsumerSignal): void {
    this.logger.log(JSON.stringify(signal));
  }
}
