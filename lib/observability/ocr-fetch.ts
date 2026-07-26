export const OCR_FETCH_TELEMETRY = {
  propagateContext: true,
  spanName: 'ocr_agent.extract',
  attributes: {
    'teamflow.pipeline.stage': 'ocr_request',
  },
} as const;

export function createOcrFetchOptions(
  body: FormData,
  token: string,
): RequestInit {
  return {
    method: 'POST',
    headers: {
      'X-OCR-Token': token,
    },
    body,
    opentelemetry: OCR_FETCH_TELEMETRY,
  };
}
