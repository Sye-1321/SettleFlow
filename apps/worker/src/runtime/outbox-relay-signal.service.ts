import { Injectable } from '@nestjs/common';
import type { OutboxRelaySignal } from '@settleflow/eventing';
import { TelemetryRuntime } from '@settleflow/infrastructure';

@Injectable()
export class OutboxRelaySignalService {
  public constructor(private readonly telemetry: TelemetryRuntime) {}

  public record(signal: OutboxRelaySignal): void {
    this.telemetry.logger.record('info', signal);
  }
}
