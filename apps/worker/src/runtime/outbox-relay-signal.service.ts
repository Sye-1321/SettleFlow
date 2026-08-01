import { Injectable, Logger } from '@nestjs/common';
import type { OutboxRelaySignal } from '@settleflow/eventing';

@Injectable()
export class OutboxRelaySignalService {
  private readonly logger = new Logger(OutboxRelaySignalService.name);

  public record(signal: OutboxRelaySignal): void {
    this.logger.log(JSON.stringify(signal));
  }
}
