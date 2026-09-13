export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function rowsResult<T>(rows: T[]) {
  return jsonResult(rows);
}
