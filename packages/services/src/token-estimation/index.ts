export interface TokenEstimate {
  tokens: number;
  model: string;
}

export function estimateTokens(text: string, _model: string = "gpt-4"): TokenEstimate {
  const charCount = text.length;
  const tokens = Math.ceil(charCount / 4);
  return { tokens, model: _model };
}
