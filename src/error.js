class APIError extends Error {
  constructor(status, error, message, headers) {
    super(APIError.makeMessage(status, error, message));
    this.status = status;
    this.headers = headers;
    this.request_id = headers ? headers['x-request-id'] : undefined;

    const data = error;
    this.error = data;
    this.code = data ? data['code'] : undefined;
    this.param = data ? data['param'] : undefined;
    this.type = data ? data['type'] : undefined;
  }

  static makeMessage(status, error, message) {
    const msg =
      error && error.message
        ? typeof error.message === 'string'
          ? error.message
          : JSON.stringify(error.message)
        : error
        ? JSON.stringify(error)
        : message;

    if (status && msg) {
      return `${status} ${msg}`;
    }
    if (status) {
      return `${status} status code (no body)`;
    }
    if (msg) {
      return msg;
    }
    return '(no status code or body)';
  }
}
