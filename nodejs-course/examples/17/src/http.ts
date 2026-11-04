export interface ValidationDetail { field: string; code: string; message: string; }

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly details: ValidationDetail[] = []) {
    super(message);
  }
}
