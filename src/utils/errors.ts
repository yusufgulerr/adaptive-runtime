const MAX_ERROR_MESSAGE_LENGTH = 1000;

export function errorMessage(error: unknown, maxLength: number = MAX_ERROR_MESSAGE_LENGTH): string {
  const raw = error instanceof Error ? error.message : String(error);
  const bound =
    Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : MAX_ERROR_MESSAGE_LENGTH;
  return raw.length > bound ? `${raw.slice(0, bound)}…` : raw;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
