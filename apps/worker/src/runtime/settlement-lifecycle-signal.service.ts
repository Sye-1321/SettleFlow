import { Injectable } from '@nestjs/common';
import type { SettlementLifecycleConsumerSignal } from '@settleflow/eventing';
import { TelemetryRuntime } from '@settleflow/infrastructure';

@Injectable()
export class SettlementLifecycleSignalService {
  public constructor(private readonly telemetry: TelemetryRuntime) {}

  public record(signal: SettlementLifecycleConsumerSignal): void {
    this.telemetry.logger.record('info', signal);
  }
}
