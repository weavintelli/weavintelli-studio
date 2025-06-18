import {
  Content,
  File,
  FileState,
  FunctionCall,
  GenerateContentConfig,
  GenerateImagesConfig,
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Modality,
  Model as GeminiModel,
  Pager,
  Part,
  SafetySetting,
  SendMessageParameters,
  ThinkingConfig,
  Tool
} from '@google/genai'
import { nanoid } from '@reduxjs/toolkit'
import { GenericChunk } from '@renderer/aiCore/middleware/schemas'
import {
  findTokenLimit,
  GEMINI_FLASH_MODEL_REGEX,
  isGeminiReasoningModel,
  isGemmaModel,
  isVisionModel
} from '@renderer/config/models'
import { CacheService } from '@renderer/services/CacheService'
import { estimateTextTokens } from '@renderer/services/TokenService'
import {
  Assistant,
  EFFORT_RATIO,
  FileType,
  FileTypes,
  GenerateImageParams,
  MCPCallToolResponse,
  MCPTool,
  MCPToolResponse,
  Model,
  Provider,
  ToolCallResponse,
  WebSearchSource
} from '@renderer/types'
import { ChunkType, LLMWebSearchCompleteChunk } from '@renderer/types/chunk'
import { Message } from '@renderer/types/newMessage'
import {
  GeminiOptions,
  GeminiSdkMessageParam,
  GeminiSdkParams,
  GeminiSdkRawChunk,
  GeminiSdkRawOutput,
  GeminiSdkToolCall
} from '@renderer/types/sdk'
import {
  geminiFunctionCallToMcpTool,
  isEnabledToolUse,
  mcpToolCallResponseToGeminiMessage,
  mcpToolsToGeminiTools
} from '@renderer/utils/mcp-tools'
import { findFileBlocks, findImageBlocks, getMainTextContent } from '@renderer/utils/messageUtils/find'
import { buildSystemPrompt } from '@renderer/utils/prompt'
import { MB } from '@shared/config/constant'

import { BaseApiClient } from '../BaseApiClient'
import { RequestTransformer, ResponseChunkTransformer } from '../types'

export class GeminiAPIClient extends BaseApiClient<
  GoogleGenAI,
  GeminiSdkParams,
  GeminiSdkRawOutput,
  GeminiSdkRawChunk,
  GeminiSdkMessageParam,
  GeminiSdkToolCall,
  Tool
> {
  constructor(provider: Provider) {
    super(provider)
  }

  override async createCompletions(payload: GeminiSdkParams, options?: GeminiOptions): Promise<GeminiSdkRawOutput> {
    const sdk = await this.getSdkInstance()
    const { model, history, ...rest } = payload
    const realPayload: Omit<GeminiSdkParams, 'model'> = {
      ...rest,
      config: {
        ...rest.config,
        abortSignal: options?.abortSignal,
        httpOptions: {
          ...rest.config?.httpOptions,
          timeout: options?.timeout
        }
      }
    } satisfies SendMessageParameters

    const streamOutput = options?.streamOutput

    const chat = sdk.chats.create({
      model: model,
      history: history
    })

    if (streamOutput) {
      const stream = chat.sendMessageStream(realPayload)
      return stream
    } else {
      const response = await chat.sendMessage(realPayload)
      return response
    }
  }

  override async generateImage(generateImageParams: GenerateImageParams): Promise<string[]> {
    const sdk = await this.getSdkInstance()
    try {
      const { model, prompt, imageSize, batchSize, signal } = generateImageParams
      const config: GenerateImagesConfig = {
        numberOfImages: batchSize,
        aspectRatio: imageSize,
        abortSignal: signal,
        httpOptions: {
          timeout: 5 * 60 * 1000
        }
      }
      const response = await sdk.models.generateImages({
        model: model,
        prompt,
        config
      })

      if (!response.generatedImages || response.generatedImages.length === 0) {
        return []
      }

      const images = response.generatedImages
        .filter((image) => image.image?.imageBytes)
        .map((image) => {
          const dataPrefix = `data:${image.image?.mimeType || 'image/png'};base64,`
          return dataPrefix + image.image?.imageBytes
        })
      //  console.log(response?.generatedImages?.[0]?.image?.imageBytes);
      return images
    } catch (error) {
      console.error('[generateImage] error:', error)
      throw error
    }
  }

  override async getEmbeddingDimensions(model: Model): Promise<number> {
    const sdk = await this.getSdkInstance()
    try {
      const data = await sdk.models.embedContent({
        model: model.id,
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
      })
      return data.embeddings?.[0]?.values?.length || 0
    } catch (e) {
      return 0
    }
  }

  override async listModels(): Promise<GeminiModel[]> {
    const sdk = await this.getSdkInstance()
    const response = await sdk.models.list()
    const models: GeminiModel[] = []
    for await (const model of response) {
      models.push(model)
    }
    return models
  }

  override async getSdkInstance() {
    if (this.sdkInstance) {
      return this.sdkInstance
    }

    this.sdkInstance = new GoogleGenAI({
      vertexai: false,
      apiKey: this.apiKey,
      apiVersion: this.getApiVersion(),
      httpOptions: {
        baseUrl: this.getBaseURL(),
        apiVersion: this.getApiVersion()
      }
    })

    return this.sdkInstance
  }

  protected getApiVersion(): string {
    if (this.provider.isVertex) {
      return 'v1'
    }
    return 'v1beta'
  }

  /**
   * Handle a PDF file
   * @param file - The file
   * @returns The part
   */
  private async handlePdfFile(file: FileType): Promise<Part> {
    const smallFileSize = 20 * MB
    const isSmallFile = file.size < smallFileSize

    if (isSmallFile) {
      const { data, mimeType } = await this.base64File(file)
      return {
        inlineData: {
          data,
          mimeType
        } as Part['inlineData']
      }
    }

    // Retrieve file from Gemini uploaded files
    const fileMetadata: File | undefined = await this.retrieveFile(file)

    if (fileMetadata) {
      return {
        fileData: {
          fileUri: fileMetadata.uri,
          mimeType: fileMetadata.mimeType
        } as Part['fileData']
      }
    }

    // If file is not found, upload it to Gemini
    const result = await this.uploadFile(file)

    return {
      fileData: {
        fileUri: result.uri,
        mimeType: result.mimeType
      } as Part['fileData']
    }
  }

  /**
   * Get the message contents
   * @param message - The message
   * @returns The message contents
   */
  private async convertMessageToSdkParam(message: Message): Promise<Content> {
    const role = message.role === 'user' ? 'user' : 'model'
    const parts: Part[] = [{ text: await this.getMessageContent(message) }]
    // Add any generated images from previous responses
    const imageBlocks = findImageBlocks(message)
    for (const imageBlock of imageBlocks) {
      if (
        imageBlock.metadata?.generateImageResponse?.images &&
        imageBlock.metadata.generateImageResponse.images.length > 0
      ) {
        for (const imageUrl of imageBlock.metadata.generateImageResponse.images) {
          if (imageUrl && imageUrl.startsWith('data:')) {
            // Extract base64 data and mime type from the data URL
            const matches = imageUrl.match(/^data:(.+);base64,(.*)$/)
            if (matches && matches.length === 3) {
              const mimeType = matches[1]
              const base64Data = matches[2]
              parts.push({
                inlineData: {
                  data: base64Data,
                  mimeType: mimeType
                } as Part['inlineData']
              })
            }
          }
        }
      }
      const file = imageBlock.file
      if (file) {
        const base64Data = await window.api.file.base64Image(file.id + file.ext)
        parts.push({
          inlineData: {
            data: base64Data.base64,
            mimeType: base64Data.mime
          } as Part['inlineData']
        })
      }
    }

    const fileBlocks = findFileBlocks(message)
    for (const fileBlock of fileBlocks) {
      const file = fileBlock.file
      if (file.type === FileTypes.IMAGE) {
        const base64Data = await window.api.file.base64Image(file.id + file.ext)
        parts.push({
          inlineData: {
            data: base64Data.base64,
            mimeType: base64Data.mime
          } as Part['inlineData']
        })
      }

      if (file.ext === '.pdf') {
        parts.push(await this.handlePdfFile(file))
        continue
      }
      if ([FileTypes.TEXT, FileTypes.DOCUMENT].includes(file.type)) {
        const fileContent = await (await window.api.file.read(file.id + file.ext)).trim()
        parts.push({
          text: file.origin_name + '\n' + fileContent
        })
      }
    }

    return {
      role,
      parts: parts
    }
  }

  // @ts-ignore unused
  private async getImageFileContents(message: Message): Promise<Content> {
    const role = message.role === 'user' ? 'user' : 'model'
    const content = getMainTextContent(message)
    const parts: Part[] = [{ text: content }]
    const imageBlocks = findImageBlocks(message)
    for (const imageBlock of imageBlocks) {
      if (
        imageBlock.metadata?.generateImageResponse?.images &&
        imageBlock.metadata.generateImageResponse.images.length > 0
      ) {
        for (const imageUrl of imageBlock.metadata.generateImageResponse.images) {
          if (imageUrl && imageUrl.startsWith('data:')) {
            // Extract base64 data and mime type from the data URL
            const matches = imageUrl.match(/^data:(.+);base64,(.*)$/)
            if (matches && matches.length === 3) {
              const mimeType = matches[1]
              const base64Data = matches[2]
              parts.push({
                inlineData: {
                  data: base64Data,
                  mimeType: mimeType
                } as Part['inlineData']
              })
            }
          }
        }
      }
      const file = imageBlock.file
      if (file) {
        const base64Data = await window.api.file.base64Image(file.id + file.ext)
        parts.push({
          inlineData: {
            data: base64Data.base64,
            mimeType: base64Data.mime
          } as Part['inlineData']
        })
      }
    }
    return {
      role,
      parts: parts
    }
  }

  /**
   * Get the safety settings
   * @returns The safety settings
   */
  private getSafetySettings(): SafetySetting[] {
    const safetyThreshold = 'OFF' as HarmBlockThreshold

    return [
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: safetyThreshold
      },
      {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: safetyThreshold
      },
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: safetyThreshold
      },
      {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: safetyThreshold
      },
      {
        category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
        threshold: HarmBlockThreshold.BLOCK_NONE
      }
    ]
  }

  /**
   * Get the reasoning effort for the assistant
   * @param assistant - The assistant
   * @param model - The model
   * @returns The reasoning effort
   */
  private getBudgetToken(assistant: Assistant, model: Model) {
    if (isGeminiReasoningModel(model)) {
      const reasoningEffort = assistant?.settings?.reasoning_effort

      // 如果thinking_budget是undefined，不思考
      if (reasoningEffort === undefined) {
        return {
          thinkingConfig: {
            includeThoughts: false,
            ...(GEMINI_FLASH_MODEL_REGEX.test(model.id) ? { thinkingBudget: 0 } : {})
          } as ThinkingConfig
        }
      }

      const effortRatio = EFFORT_RATIO[reasoningEffort]

      if (effortRatio > 1) {
        return {
          thinkingConfig: {
            includeThoughts: true
          }
        }
      }

      const { max } = findTokenLimit(model.id) || { max: 0 }
      const budget = Math.floor(max * effortRatio)

      return {
        thinkingConfig: {
          ...(budget > 0 ? { thinkingBudget: budget } : {}),
          includeThoughts: true
        } as ThinkingConfig
      }
    }

    return {}
  }

  private getGenerateImageParameter(): Partial<GenerateContentConfig> {
    return {
      systemInstruction: undefined,
      responseModalities: [Modality.TEXT, Modality.IMAGE],
      responseMimeType: 'text/plain'
    }
  }

  getRequestTransformer(): RequestTransformer<GeminiSdkParams, GeminiSdkMessageParam> {
    return {
      transform: async (
        coreRequest,
        assistant,
        model,
        isRecursiveCall,
        recursiveSdkMessages
      ): Promise<{
        payload: GeminiSdkParams
        messages: GeminiSdkMessageParam[]
        metadata: Record<string, any>
      }> => {
        const { messages, mcpTools, maxTokens, enableWebSearch, enableGenerateImage } = coreRequest
        // 1. 处理系统消息
        let systemInstruction = assistant.prompt

        // 2. 设置工具
        const { tools } = this.setupToolsConfig({
          mcpTools,
          model,
          enableToolUse: isEnabledToolUse(assistant)
        })

        if (this.useSystemPromptForTools) {
          systemInstruction = await buildSystemPrompt(assistant.prompt || '', mcpTools, assistant)
        }

        let messageContents: Content
        const history: Content[] = []
        // 3. 处理用户消息
        if (typeof messages === 'string') {
          messageContents = {
            role: 'user',
            parts: [{ text: messages }]
          }
        } else {
          const userLastMessage = messages.pop()!
          messageContents = await this.convertMessageToSdkParam(userLastMessage)
          for (const message of messages) {
            history.push(await this.convertMessageToSdkParam(message))
          }
        }

        if (enableWebSearch) {
          tools.push({
            googleSearch: {}
          })
        }

        if (isGemmaModel(model) && assistant.prompt) {
          const isFirstMessage = history.length === 0
          if (isFirstMessage && messageContents) {
            const systemMessage = [
              {
                text:
                  '<start_of_turn>user\n' +
                  systemInstruction +
                  '<end_of_turn>\n' +
                  '<start_of_turn>user\n' +
                  (messageContents?.parts?.[0] as Part).text +
                  '<end_of_turn>'
              }
            ] as Part[]
            if (messageContents && messageContents.parts) {
              messageContents.parts[0] = systemMessage[0]
            }
          }
        }

        const newHistory =
          isRecursiveCall && recursiveSdkMessages && recursiveSdkMessages.length > 0
            ? recursiveSdkMessages.slice(0, recursiveSdkMessages.length - 1)
            : history

        const newMessageContents =
          isRecursiveCall && recursiveSdkMessages && recursiveSdkMessages.length > 0
            ? {
                ...messageContents,
                parts: [
                  ...(messageContents.parts || []),
                  ...(recursiveSdkMessages[recursiveSdkMessages.length - 1].parts || [])
                ]
              }
            : messageContents

        const generateContentConfig: GenerateContentConfig = {
          safetySettings: this.getSafetySettings(),
          systemInstruction: isGemmaModel(model) ? undefined : systemInstruction,
          temperature: this.getTemperature(assistant, model),
          topP: this.getTopP(assistant, model),
          maxOutputTokens: maxTokens,
          tools: tools,
          ...(enableGenerateImage ? this.getGenerateImageParameter() : {}),
          ...this.getBudgetToken(assistant, model),
          ...this.getCustomParameters(assistant)
        }

        const param: GeminiSdkParams = {
          model: model.id,
          config: generateContentConfig,
          history: newHistory,
          message: newMessageContents.parts!
        }

        return {
          payload: param,
          messages: [messageContents],
          metadata: {}
        }
      }
    }
  }

  getResponseChunkTransformer(): ResponseChunkTransformer<GeminiSdkRawChunk> {
    return () => ({
      async transform(chunk: GeminiSdkRawChunk, controller: TransformStreamDefaultController<GenericChunk>) {
        let toolCalls: FunctionCall[] = []
        if (chunk.candidates && chunk.candidates.length > 0) {
          for (const candidate of chunk.candidates) {
            if (candidate.content) {
              candidate.content.parts?.forEach((part) => {
                const text = part.text || ''
                if (part.thought) {
                  controller.enqueue({
                    type: ChunkType.THINKING_DELTA,
                    text: text
                  })
                } else if (part.text) {
                  controller.enqueue({
                    type: ChunkType.TEXT_DELTA,
                    text: text
                  })
                } else if (part.inlineData) {
                  controller.enqueue({
                    type: ChunkType.IMAGE_COMPLETE,
                    image: {
                      type: 'base64',
                      images: [
                        part.inlineData?.data?.startsWith('data:')
                          ? part.inlineData?.data
                          : `data:${part.inlineData?.mimeType || 'image/png'};base64,${part.inlineData?.data}`
                      ]
                    }
                  })
                }
              })
            }

            if (candidate.finishReason) {
              if (candidate.groundingMetadata) {
                controller.enqueue({
                  type: ChunkType.LLM_WEB_SEARCH_COMPLETE,
                  llm_web_search: {
                    results: candidate.groundingMetadata,
                    source: WebSearchSource.GEMINI
                  }
                } as LLMWebSearchCompleteChunk)
              }
              if (chunk.functionCalls) {
                toolCalls = toolCalls.concat(chunk.functionCalls)
              }
              controller.enqueue({
                type: ChunkType.LLM_RESPONSE_COMPLETE,
                response: {
                  usage: {
                    prompt_tokens: chunk.usageMetadata?.promptTokenCount || 0,
                    completion_tokens:
                      (chunk.usageMetadata?.totalTokenCount || 0) - (chunk.usageMetadata?.promptTokenCount || 0),
                    total_tokens: chunk.usageMetadata?.totalTokenCount || 0
                  }
                }
              })
            }
          }
        }

        if (toolCalls.length > 0) {
          controller.enqueue({
            type: ChunkType.MCP_TOOL_CREATED,
            tool_calls: toolCalls
          })
        }
      }
    })
  }

  public convertMcpToolsToSdkTools(mcpTools: MCPTool[]): Tool[] {
    return mcpToolsToGeminiTools(mcpTools)
  }

  public convertSdkToolCallToMcp(toolCall: GeminiSdkToolCall, mcpTools: MCPTool[]): MCPTool | undefined {
    return geminiFunctionCallToMcpTool(mcpTools, toolCall)
  }

  public convertSdkToolCallToMcpToolResponse(toolCall: GeminiSdkToolCall, mcpTool: MCPTool): ToolCallResponse {
    const parsedArgs = (() => {
      try {
        return typeof toolCall.args === 'string' ? JSON.parse(toolCall.args) : toolCall.args
      } catch {
        return toolCall.args
      }
    })()

    return {
      id: toolCall.id || nanoid(),
      toolCallId: toolCall.id,
      tool: mcpTool,
      arguments: parsedArgs,
      status: 'pending'
    } as ToolCallResponse
  }

  public convertMcpToolResponseToSdkMessageParam(
    mcpToolResponse: MCPToolResponse,
    resp: MCPCallToolResponse,
    model: Model
  ): GeminiSdkMessageParam | undefined {
    if ('toolUseId' in mcpToolResponse && mcpToolResponse.toolUseId) {
      return mcpToolCallResponseToGeminiMessage(mcpToolResponse, resp, isVisionModel(model))
    } else if ('toolCallId' in mcpToolResponse) {
      return {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: mcpToolResponse.toolCallId,
              name: mcpToolResponse.tool.id,
              response: {
                output: !resp.isError ? resp.content : undefined,
                error: resp.isError ? resp.content : undefined
              }
            }
          }
        ]
      } satisfies Content
    }
    return
  }

  public buildSdkMessages(
    currentReqMessages: Content[],
    output: string,
    toolResults: Content[],
    toolCalls: FunctionCall[]
  ): Content[] {
    const parts: Part[] = []
    if (output) {
      parts.push({
        text: output
      })
    }
    toolCalls.forEach((toolCall) => {
      parts.push({
        functionCall: toolCall
      })
    })
    parts.push(
      ...toolResults
        .map((ts) => ts.parts)
        .flat()
        .filter((p) => p !== undefined)
    )

    const userMessage: Content = {
      role: 'user',
      parts: parts
    }

    return [...currentReqMessages, userMessage]
  }

  override estimateMessageTokens(message: GeminiSdkMessageParam): number {
    return (
      message.parts?.reduce((acc, part) => {
        if (part.text) {
          return acc + estimateTextTokens(part.text)
        }
        if (part.functionCall) {
          return acc + estimateTextTokens(JSON.stringify(part.functionCall))
        }
        if (part.functionResponse) {
          return acc + estimateTextTokens(JSON.stringify(part.functionResponse.response))
        }
        if (part.inlineData) {
          return acc + estimateTextTokens(part.inlineData.data || '')
        }
        if (part.fileData) {
          return acc + estimateTextTokens(part.fileData.fileUri || '')
        }
        return acc
      }, 0) || 0
    )
  }

  public extractMessagesFromSdkPayload(sdkPayload: GeminiSdkParams): GeminiSdkMessageParam[] {
    return sdkPayload.history || []
  }

  private async uploadFile(file: FileType): Promise<File> {
    return await this.sdkInstance!.files.upload({
      file: file.path,
      config: {
        mimeType: 'application/pdf',
        name: file.id,
        displayName: file.origin_name
      }
    })
  }

  private async base64File(file: FileType) {
    const { data } = await window.api.file.base64File(file.id + file.ext)
    return {
      data,
      mimeType: 'application/pdf'
    }
  }

  private async retrieveFile(file: FileType): Promise<File | undefined> {
    const cachedResponse = CacheService.get<any>('gemini_file_list')

    if (cachedResponse) {
      return this.processResponse(cachedResponse, file)
    }

    const response = await this.sdkInstance!.files.list()
    CacheService.set('gemini_file_list', response, 3000)

    return this.processResponse(response, file)
  }

  private async processResponse(response: Pager<File>, file: FileType) {
    for await (const f of response) {
      if (f.state === FileState.ACTIVE) {
        if (f.displayName === file.origin_name && Number(f.sizeBytes) === file.size) {
          return f
        }
      }
    }

    return undefined
  }

  // @ts-ignore unused
  private async listFiles(): Promise<File[]> {
    const files: File[] = []
    for await (const f of await this.sdkInstance!.files.list()) {
      files.push(f)
    }
    return files
  }

  // @ts-ignore unused
  private async deleteFile(fileId: string) {
    await this.sdkInstance!.files.delete({ name: fileId })
  }
}
