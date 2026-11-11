export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Thrown by every placeholder, so unbuilt features fail loudly and never fake success. */
export class PendingIntegrationError extends AppError {
  constructor(feature: string) {
    super(501, 'INTEGRATION_PENDING', `${feature} is not implemented yet.`);
  }
}
