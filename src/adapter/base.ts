import { HttpResponse, ServiceError, TextTranslateQuery, ValidationCompletion } from "@bob-translate/types";
import { handleGeneralError, convertToServiceError } from "../utils";
import type { GeminiResponse, OpenAiChatCompletion, ServiceAdapter, ServiceAdapterConfig } from "../types";

export abstract class BaseAdapter implements ServiceAdapter {
  protected constructor(protected readonly config: ServiceAdapterConfig) { }

  protected getTemperature(): number {
    return Number($option.temperature) ?? 0.2;
  }

  protected isStreamEnabled(): boolean {
    return $option.stream === "enable";
  }

  protected getModel(): string {
    return $option.model === "custom" ? $option.customModel : $option.model;
  }

  abstract buildHeaders(apiKey: string): Record<string, string>;

  abstract buildRequestBody(query: TextTranslateQuery): Record<string, unknown>;

  abstract getTextGenerationUrl(apiUrl: string): string;

  abstract handleStream(streamData: { text: string }, query: TextTranslateQuery, targetText: string): string;

  abstract parseResponse(response: HttpResponse<GeminiResponse | OpenAiChatCompletion>): string;

  abstract testApiConnection(apiKey: string, apiUrl: string, completion: ValidationCompletion): Promise<void>;

  protected abstract extractErrorFromResponse(response: HttpResponse<any>): ServiceError;

  protected handleInvalidToken(query: TextTranslateQuery) {
    handleGeneralError(query, {
      type: "secretKey",
      message: "配置错误 - 请确保您在插件配置中填入了正确的 API Keys",
      addition: "请在插件配置中填写正确的 API Keys",
      troubleshootingLink: this.config.troubleshootingLink
    });
  }

  protected handleStreamCompletion(query: TextTranslateQuery, targetText: string) {
    query.onCompletion({
      result: {
        from: query.detectFrom,
        to: query.detectTo,
        toParagraphs: [targetText],
      },
    });
  }

  protected handleGeneralCompletion(query: TextTranslateQuery, text: string) {
    query.onCompletion({
      result: {
        from: query.detectFrom,
        to: query.detectTo,
        toParagraphs: text.split("\n"),
      },
    });
  }

  protected handleRequestError(query: TextTranslateQuery, error: unknown) {
    const serviceError = convertToServiceError(error);
    if (serviceError.troubleshootingLink === undefined) {
      serviceError.troubleshootingLink = this.config.troubleshootingLink;
    }
    handleGeneralError(query, serviceError);
  }

  public async translate(
    query: TextTranslateQuery,
    apiKey: string,
    apiUrl: string,
    isStream: boolean
  ): Promise<void> {
    try {
      const url = this.getTextGenerationUrl(apiUrl);
      const header = this.buildHeaders(apiKey);
      const body = this.buildRequestBody(query);

      if (isStream) {
        await this.makeStreamRequest(url, header, body, query);
      } else {
        await this.makeRequest(url, header, body, query);
      }
    } catch (error) {
      this.handleRequestError(query, error);
    }
  }

  public async makeStreamRequest(
    url: string,
    header: Record<string, string>,
    body: Record<string, unknown>,
    query: TextTranslateQuery,
  ): Promise<void> {
    let targetText = "";
    await $http.streamRequest({
      method: "POST",
      url,
      header,
      body,
      cancelSignal: query.cancelSignal,
      streamHandler: (streamData) => {
        if (streamData.text?.includes("Invalid token")) {
          this.handleInvalidToken(query);
          return;
        }

        if (!streamData.text) {
          return;
        }

        targetText = this.handleStream(
          { text: streamData.text },
          query,
          targetText
        );
      },
      handler: (result) => {
        if (result.response.statusCode >= 400) {
          handleGeneralError(query, this.extractErrorFromResponse(result));
        } else {
          this.handleStreamCompletion(query, targetText);
        }
      }
    });
  }

  public async makeRequest(
    url: string,
    header: Record<string, string>,
    body: Record<string, unknown>,
    query: TextTranslateQuery,
  ): Promise<void> {
    try {
      const result = await $http.request({
        method: "POST",
        url,
        header,
        body,
      });

      if (result.error || result.response.statusCode >= 400) {
        handleGeneralError(query, this.extractErrorFromResponse(result));
      } else {
        const text = this.parseResponse(result);
        this.handleGeneralCompletion(query, text);
      }
    } catch (error) {
      this.handleRequestError(query, error);
    }
  }
}