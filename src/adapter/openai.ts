import type {
  HttpResponse,
  ServiceError,
  TextTranslateQuery,
  ValidationCompletion,
} from '@bob-translate/types';
import type {
  GeminiResponse,
  OpenAiErrorResponse,
  OpenAiResponse,
  ServiceAdapterConfig,
} from '../types';
import {
  generatePrompts,
  handleValidateError,
  replacePromptKeywords,
} from '../utils';
import { LineDecoder, SseDecoder, type SseMessage } from '../utils/sse';
import { BaseAdapter } from './base';

export class OpenAiAdapter extends BaseAdapter {
  private sseDecoder = new SseDecoder();
  private lineDecoder = new LineDecoder();

  constructor(config?: ServiceAdapterConfig) {
    super(
      config || {
        troubleshootingLink:
          'https://bobtranslate.com/service/translate/openai.html',
        baseUrl: $option.apiUrl || 'https://api.openai.com',
      },
    );
  }

  protected extractErrorFromResponse(
    errorResponse: HttpResponse<unknown>,
  ): ServiceError {
    const data = errorResponse.data as
      | OpenAiErrorResponse
      | Record<string, unknown>;
    const statusCode = errorResponse.response?.statusCode;

    const baseError: ServiceError = {
      type: statusCode === 401 ? 'secretKey' : 'api',
      message: 'API request failed',
      addition: JSON.stringify(data),
      troubleshootingLink: this.config.troubleshootingLink,
    };

    // Case 1: error is string
    if (typeof data?.error === 'string') {
      return {
        ...baseError,
        message: data.error,
      };
    }

    // Case 2: error is object with message
    if (
      typeof data === 'object' &&
      'error' in data &&
      data.error &&
      typeof data.error === 'object' &&
      'message' in data.error
    ) {
      const errorObj = data.error as { message: string; param?: string };
      let errorMessage = errorObj.message;
      if (errorObj.param) {
        errorMessage = `${errorMessage} (parameter: ${errorObj.param})`;
      }
      return {
        ...baseError,
        message: errorMessage,
      };
    }

    // Case 3: Generic error
    return baseError;
  }

  public buildHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  public buildRequestBody(query: TextTranslateQuery): Record<string, unknown> {
    const { customSystemPrompt, customUserPrompt } = $option;
    const { generatedSystemPrompt, generatedUserPrompt } =
      generatePrompts(query);

    let systemPrompt =
      replacePromptKeywords(customSystemPrompt, query) || generatedSystemPrompt;
    const userPrompt =
      replacePromptKeywords(customUserPrompt, query) || generatedUserPrompt;

    const formattingInstructions =
      '\n\nIMPORTANT: Output the translation directly without any quotation marks or special characters wrapping. Do not add quotes like 『』「」"" around the result.';
    systemPrompt += formattingInstructions;

    return {
      model: this.getModel(),
      temperature: this.getTemperature(),
      stream: this.isStreamEnabled(),
      instructions: systemPrompt,
      input: userPrompt,
    };
  }

  public parseResponse(
    response: HttpResponse<GeminiResponse | OpenAiResponse>,
  ): string {
    const { data } = response;

    // Handle Responses API format
    if (typeof data === 'object' && 'output' in data) {
      const openAiResponse = data as OpenAiResponse;
      // Use the helper field if available
      if (openAiResponse.output_text) {
        return openAiResponse.output_text.trim();
      }
      // Otherwise extract from output array
      if (openAiResponse.output && openAiResponse.output.length > 0) {
        // Look for message type items in the output array
        for (const item of openAiResponse.output) {
          if (
            item.type === 'message' &&
            item.content &&
            item.content.length > 0
          ) {
            const text = item.content
              .filter((c) => c.type === 'output_text')
              .map((c) => c.text)
              .join('');
            if (text) {
              return text.trim();
            }
          }
        }
      }
      throw new Error('No output returned from Responses API');
    }

    throw new Error('Unsupported response type');
  }

  public getTextGenerationUrl(_apiUrl: string): string {
    return `${this.config.baseUrl}/v1/responses`;
  }

  protected getValidationUrl(_apiUrl: string): string {
    return `${this.config.baseUrl}/v1/models`;
  }

  private extractDeltaFromData(
    dataObj: Record<string, unknown>,
  ): string | null {
    // Handle new Responses API event stream format
    if (
      dataObj.type === 'response.output_text.delta' &&
      typeof dataObj.delta === 'string'
    ) {
      return dataObj.delta;
    }

    // Handle old Responses API stream format (if still used)
    if (
      dataObj.object === 'response.chunk' &&
      dataObj.delta &&
      typeof dataObj.delta === 'object'
    ) {
      const delta = dataObj.delta as Record<string, unknown>;
      if (Array.isArray(delta.output)) {
        const output = delta.output;
        if (output.length > 0 && output[0] && typeof output[0] === 'object') {
          const firstOutput = output[0] as Record<string, unknown>;
          if (Array.isArray(firstOutput.content)) {
            return (
              firstOutput.content
                .filter(
                  (
                    content: unknown,
                  ): content is { type?: string; text?: string } =>
                    typeof content === 'object' &&
                    content !== null &&
                    'type' in content &&
                    content.type === 'output_text' &&
                    'text' in content &&
                    typeof content.text === 'string',
                )
                .map((content) => content.text)
                .join('') || null
            );
          }
        }
      }
    }

    return null;
  }

  private parseSseMessage(sse: SseMessage): string | null {
    // Handle [DONE] message
    if (sse.data === '[DONE]' || sse.data.startsWith('[DONE]')) {
      return null;
    }

    try {
      const dataObj = JSON.parse(sse.data);

      // Check for errors in the data
      if (dataObj.error) {
        throw {
          type: dataObj.error.type || 'api',
          message: dataObj.error.message || 'API request failed',
          addition: dataObj.error.param
            ? `Parameter: ${dataObj.error.param}`
            : undefined,
          troubleshootingLink: this.config.troubleshootingLink,
        };
      }

      // Only process response.output_text.delta events
      if (
        sse.event === 'response.output_text.delta' ||
        (!sse.event && dataObj.type === 'response.output_text.delta')
      ) {
        return typeof dataObj.delta === 'string' ? dataObj.delta : null;
      }

      // Try to extract delta from other formats
      return this.extractDeltaFromData(dataObj);
    } catch (error) {
      // If it's our custom error object, re-throw it
      if (error && typeof error === 'object' && 'type' in error) {
        throw error;
      }

      // Log parsing errors but don't throw
      console.error('Failed to parse SSE message:', sse.data, error);
      return null;
    }
  }

  public handleStream(
    streamData: { text: string },
    query: TextTranslateQuery,
    targetText: string,
  ): string {
    // Process the incoming chunk through the line decoder
    const lines = this.lineDecoder.decode(streamData.text);

    for (const line of lines) {
      const sse = this.sseDecoder.decode(line);
      if (sse) {
        try {
          const delta = this.parseSseMessage(sse);
          if (delta) {
            targetText += delta;
            query.onStream({
              result: {
                from: query.detectFrom,
                to: query.detectTo,
                toParagraphs: [targetText],
              },
            });
          }
        } catch (error) {
          // Handle errors from parseSseMessage
          if (error && typeof error === 'object' && 'type' in error) {
            throw error; // Re-throw API errors
          }
          // Log other errors but continue processing
          console.error('Error processing SSE message:', error);
        }
      }
    }

    return targetText;
  }

  public async testApiConnection(
    apiKey: string,
    apiUrl: string,
    completion: ValidationCompletion,
  ): Promise<void> {
    const header = this.buildHeaders(apiKey);
    const validationUrl = this.getValidationUrl(apiUrl);

    try {
      const response = await $http.request({
        method: 'GET',
        url: validationUrl,
        header,
      });

      const responseData = response.data;
      if (responseData?.error) {
        return handleValidateError(
          completion,
          this.extractErrorFromResponse(response),
        );
      }

      // Check if we got a valid models list response
      if (
        responseData &&
        (responseData.data || responseData.object === 'list')
      ) {
        return completion({ result: true });
      }
    } catch (error) {
      handleValidateError(completion, error);
    }
  }
}
