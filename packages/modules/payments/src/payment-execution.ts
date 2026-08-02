import type { PaymentCurrency } from './payments.types';

export interface PaymentExecutionCommand {
  readonly amountMinor: number;
  readonly currency: PaymentCurrency;
  readonly paymentId: string;
}

export type PaymentExecutionResult = { readonly kind: 'approved' } | { readonly kind: 'declined' };

export interface PaymentExecutionPort {
  capture(command: PaymentExecutionCommand): Promise<PaymentExecutionResult>;
  refund(command: PaymentExecutionCommand): Promise<PaymentExecutionResult>;
}

export type DeterministicPaymentOutcome = (
  command: PaymentExecutionCommand,
  operation: 'capture' | 'refund',
) => PaymentExecutionResult;

/**
 * A local deterministic simulation boundary. It performs no I/O and approves
 * by default. Tests may inject a pure outcome function; a network adapter is
 * intentionally incompatible with this contract.
 */
export class DeterministicMockPaymentExecution implements PaymentExecutionPort {
  public constructor(
    private readonly outcome: DeterministicPaymentOutcome = () => ({ kind: 'approved' }),
  ) {}

  public capture(command: PaymentExecutionCommand): Promise<PaymentExecutionResult> {
    return Promise.resolve(this.outcome(command, 'capture'));
  }

  public refund(command: PaymentExecutionCommand): Promise<PaymentExecutionResult> {
    return Promise.resolve(this.outcome(command, 'refund'));
  }
}
