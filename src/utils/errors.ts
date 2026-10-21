const MAX_ERROR_MESSAGE_LENGTH = 1000;

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > MAX_ERROR_MESSAGE_LENGTH ? `${raw.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : raw;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
