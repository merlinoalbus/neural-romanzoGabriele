import { z } from 'zod';

export function toolStructured<T extends Record<string, unknown>>(payload: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function toolError(code: string, message: string, details?: Record<string, unknown>) {
  const payload = {
    ok: false as const,
    error: { code, message, ...(details ? { details } : {}) },
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true as const,
  };
}

export const errorObj = z
  .object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() })
  .optional();
