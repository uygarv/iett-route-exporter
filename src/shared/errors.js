export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    Error.captureStackTrace?.(this, AppError);
    this.status = status;
    this.code = code;

    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function toErrorBody(error) {
  const status = error instanceof AppError ? error.status : 500;
  const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof AppError
    ? error.message
    : "An unexpected error occurred.";

  const body = {
    error: {
      code,
      message
    }
  };

  if (error instanceof AppError && error.details !== undefined) {
    body.error.details = error.details;
  }

  console.log(`Error: ${status} ${code} - ${message}`);

  return { status, body };
}
