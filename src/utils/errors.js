export class ServiceError extends Error {
  constructor(code, statusCode = 400, options = {}) {
    super(code);
    this.name = 'ServiceError';
    this.code = code;
    this.statusCode = statusCode;
    this.safeMessage = options.safeMessage;
    this.causeCode = options.causeCode;
    this.action = options.action;
    this.stage = options.stage;
    this.component = options.component;
  }
}
