import type { BridgeError, BridgeErrorCode } from './shared';

export class BridgeRequestError extends Error implements BridgeError {
  public readonly code: BridgeErrorCode;
  public readonly details?: unknown;
  constructor(error: BridgeError) {
    super(`${error.code}: ${error.message}`);
    this.code = error.code;
    this.details = error.details;
    this.name = 'BridgeRequestError';
  }
}
