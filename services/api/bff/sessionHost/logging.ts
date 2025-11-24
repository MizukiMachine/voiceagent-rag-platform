type SummaryInput = {
  text?: string;
  refusal?: string;
  limit?: number;
};

export function buildResponseSummary(response: any, input: SummaryInput) {
  const limit = input.limit ?? 800;
  return {
    id: response?.id,
    model: response?.model,
    outputLen: Array.isArray(response?.output) ? response.output.length : 0,
    refusal: input.refusal,
    hasText: Boolean(input.text && input.text.trim().length > 0),
    outputs: truncate(JSON.stringify(response?.output ?? response?.output_text ?? response ?? {}, null, 2), limit),
    usage: response?.usage,
  };
}

export function truncate(value: string, limit: number): string {
  if (!value) return '';
  if (value.length <= limit) return value;
  return value.slice(0, limit) + '...<truncated>';
}
