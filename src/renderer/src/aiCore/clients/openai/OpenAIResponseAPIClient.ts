import { GenericChunk } from '@renderer/aiCore/middleware/schemas'
import {
  isOpenAIChatCompletionOnlyModel,
  isSupportedReasoningEffortOpenAIModel,
  isVisionModel
} from '@renderer/config/models'
import { estimateTextTokens } from '@renderer/services/TokenService'
import {
  FileTypes,
  MCPCallToolResponse,
  MCPTool,
  MCPToolResponse,
  Model,
  Provider,
  ToolCallResponse,
  WebSearchSource
} from '@renderer/types'
import { ChunkType } from '@renderer/types/chunk'
import { Message } from '@renderer/types/newMessage'
import {
  OpenAIResponseSdkMessageParam,
  OpenAIResponseSdkParams,
  OpenAIResponseSdkRawChunk,
  OpenAIResponseSdkRawOutput,
  OpenAIResponseSdkTool,
  OpenAIResponseSdkToolCall
} from '@renderer/types/sdk'
import { addImageFileToContents } from '@renderer/utils/formats'
import {
  isEnabledToolUse,
  mcpToolCallResponseToOpenAIMessage,
  mcpToolsToOpenAIResponseTools,
  openAIToolsToMcpTool
} from '@renderer/utils/mcp-tools'
import { findFileBlocks, findImageBlocks } from '@renderer/utils/messageUtils/find'
import { buildSystemPrompt } from '@renderer/utils/prompt'
import { isEmpty } from 'lodash'
import OpenAI from 'openai'

import { RequestTransformer, ResponseChunkTransformer } from '../types'
import { OpenAIAPIClient } from './OpenAIApiClient'
import { OpenAIBaseClient } from './OpenAIBaseClient'

export class OpenAIResponseAPIClient extends OpenAIBaseClient<
  OpenAI,
  OpenAIResponseSdkParams,
  OpenAIResponseSdkRawOutput,
  OpenAIResponseSdkRawChunk,
  OpenAIResponseSdkMessageParam,
  OpenAIResponseSdkToolCall,
  OpenAIResponseSdkTool
> {
  private client: OpenAIAPIClient
  constructor(provider: Provider) {
    super(provider)
    this.client = new OpenAIAPIClient(provider)
  }

  /**
   * 根据模型特征选择合适的客户端
   */
  public getClient(model: Model) {
    if (isOpenAIChatCompletionOnlyModel(model)) {
      return this.client
    } else {
      return this
    }
  }

  override async getSdkInstance() {
    if (this.sdkInstance) {
      return this.sdkInstance
    }

    return new OpenAI({
      dangerouslyAllowBrowser: true,
      apiKey: this.provider.apiKey,
      baseURL: this.getBaseURL(),
      defaultHeaders: {
        ...this.defaultHeaders()
      }
    })
  }

  override async createCompletions(
    payload: OpenAIResponseSdkParams,
    options?: OpenAI.RequestOptions
  ): Promise<OpenAIResponseSdkRawOutput> {
    const sdk = await this.getSdkInstance()
    return await sdk.responses.create(payload, options)
  }

  public async convertMessageToSdkParam(message: Message, model: Model): Promise<OpenAIResponseSdkMessageParam> {
    const isVision = isVisionModel(model)
    const content = await this.getMessageContent(message)
    const fileBlocks = findFileBlocks(message)
    const imageBlocks = findImageBlocks(message)

    if (fileBlocks.length === 0 && imageBlocks.length === 0) {
      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: content
        }
      } else {
        return {
          role: message.role === 'system' ? 'user' : message.role,
          content: content ? [{ type: 'input_text', text: content }] : []
        } as OpenAI.Responses.EasyInputMessage
      }
    }

    const parts: OpenAI.Responses.ResponseInputContent[] = []
    if (content) {
      parts.push({
        type: 'input_text',
        text: content
      })
    }

    for (const imageBlock of imageBlocks) {
      if (isVision) {
        if (imageBlock.file) {
          const image = await window.api.file.base64Image(imageBlock.file.id + imageBlock.file.ext)
          parts.push({
            detail: 'auto',
            type: 'input_image',
            image_url: image.data as string
          })
        } else if (imageBlock.url && imageBlock.url.startsWith('data:')) {
          parts.push({
            detail: 'auto',
            type: 'input_image',
            image_url: imageBlock.url
          })
        }
      }
    }

    for (const fileBlock of fileBlocks) {
      const file = fileBlock.file
      if (!file) continue

      if ([FileTypes.TEXT, FileTypes.DOCUMENT].includes(file.type)) {
        const fileContent = (await window.api.file.read(file.id + file.ext)).trim()
        parts.push({
          type: 'input_text',
          text: file.origin_name + '\n' + fileContent
        })
      }
    }

    return {
      role: message.role === 'system' ? 'user' : message.role,
      content: parts
    }
  }

  public convertMcpToolsToSdkTools(mcpTools: MCPTool[]): OpenAI.Responses.Tool[] {
    return mcpToolsToOpenAIResponseTools(mcpTools)
  }

  public convertSdkToolCallToMcp(toolCall: OpenAIResponseSdkToolCall, mcpTools: MCPTool[]): MCPTool | undefined {
    return openAIToolsToMcpTool(mcpTools, toolCall)
  }
  public convertSdkToolCallToMcpToolResponse(toolCall: OpenAIResponseSdkToolCall, mcpTool: MCPTool): ToolCallResponse {
    const parsedArgs = (() => {
      try {
        return JSON.parse(toolCall.arguments)
      } catch {
        return toolCall.arguments
      }
    })()

    return {
      id: toolCall.call_id,
      toolCallId: toolCall.call_id,
      tool: mcpTool,
      arguments: parsedArgs,
      status: 'pending'
    }
  }

  public convertMcpToolResponseToSdkMessageParam(
    mcpToolResponse: MCPToolResponse,
    resp: MCPCallToolResponse,
    model: Model
  ): OpenAIResponseSdkMessageParam | undefined {
    if ('toolUseId' in mcpToolResponse && mcpToolResponse.toolUseId) {
      return mcpToolCallResponseToOpenAIMessage(mcpToolResponse, resp, isVisionModel(model))
    } else if ('toolCallId' in mcpToolResponse && mcpToolResponse.toolCallId) {
      return {
        type: 'function_call_output',
        call_id: mcpToolResponse.toolCallId,
        output: JSON.stringify(resp.content)
      }
    }
    return
  }

  public buildSdkMessages(
    currentReqMessages: OpenAIResponseSdkMessageParam[],
    output: string,
    toolResults: OpenAIResponseSdkMessageParam[],
    toolCalls: OpenAIResponseSdkToolCall[]
  ): OpenAIResponseSdkMessageParam[] {
    const assistantMessage: OpenAIResponseSdkMessageParam = {
      role: 'assistant',
      content: [{ type: 'input_text', text: output }]
    }
    const newReqMessages = [...currentReqMessages, assistantMessage, ...(toolCalls || []), ...(toolResults || [])]
    return newReqMessages
  }

  override estimateMessageTokens(message: OpenAIResponseSdkMessageParam): number {
    let sum = 0
    if ('content' in message) {
      if (typeof message.content === 'string') {
        sum += estimateTextTokens(message.content)
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          switch (part.type) {
            case 'input_text':
              sum += estimateTextTokens(part.text)
              break
            case 'input_image':
              sum += estimateTextTokens(part.image_url || '')
              break
            default:
              break
          }
        }
      }
    }
    switch (message.type) {
      case 'function_call_output':
        sum += estimateTextTokens(message.output)
        break
      case 'function_call':
        sum += estimateTextTokens(message.arguments)
        break
      default:
        break
    }
    return sum
  }

  public extractMessagesFromSdkPayload(sdkPayload: OpenAIResponseSdkParams): OpenAIResponseSdkMessageParam[] {
    if (typeof sdkPayload.input === 'string') {
      return [{ role: 'user', content: sdkPayload.input }]
    }
    return sdkPayload.input
  }

  getRequestTransformer(): RequestTransformer<OpenAIResponseSdkParams, OpenAIResponseSdkMessageParam> {
    return {
      transform: async (
        coreRequest,
        assistant,
        model,
        isRecursiveCall,
        recursiveSdkMessages
      ): Promise<{
        payload: OpenAIResponseSdkParams
        messages: OpenAIResponseSdkMessageParam[]
        metadata: Record<string, any>
      }> => {
        const { messages, mcpTools, maxTokens, streamOutput, enableWebSearch, enableGenerateImage } = coreRequest
        // 1. 处理系统消息
        const systemMessage: OpenAI.Responses.EasyInputMessage = {
          role: 'system',
          content: []
        }

        const systemMessageContent: OpenAI.Responses.ResponseInputMessageContentList = []
        const systemMessageInput: OpenAI.Responses.ResponseInputText = {
          text: assistant.prompt || '',
          type: 'input_text'
        }
        if (isSupportedReasoningEffortOpenAIModel(model)) {
          systemMessage.role = 'developer'
        }

        // 2. 设置工具
        let tools: OpenAI.Responses.Tool[] = []
        const { tools: extraTools } = this.setupToolsConfig({
          mcpTools: mcpTools,
          model,
          enableToolUse: isEnabledToolUse(assistant)
        })

        if (this.useSystemPromptForTools) {
          systemMessageInput.text = await buildSystemPrompt(systemMessageInput.text || '', mcpTools)
        }
        systemMessageContent.push(systemMessageInput)
        systemMessage.content = systemMessageContent

        // 3. 处理用户消息
        let userMessage: OpenAI.Responses.ResponseInputItem[] = []
        if (typeof messages === 'string') {
          userMessage.push({ role: 'user', content: messages })
        } else {
          const processedMessages = addImageFileToContents(messages)
          for (const message of processedMessages) {
            userMessage.push(await this.convertMessageToSdkParam(message, model))
          }
        }
        // FIXME: 最好还是直接使用previous_response_id来处理（或者在数据库中存储image_generation_call的id）
        if (enableGenerateImage) {
          const finalAssistantMessage = userMessage.findLast(
            (m) => (m as OpenAI.Responses.EasyInputMessage).role === 'assistant'
          ) as OpenAI.Responses.EasyInputMessage
          const finalUserMessage = userMessage.pop() as OpenAI.Responses.EasyInputMessage
          if (
            finalAssistantMessage &&
            Array.isArray(finalAssistantMessage.content) &&
            finalUserMessage &&
            Array.isArray(finalUserMessage.content)
          ) {
            finalAssistantMessage.content = [...finalAssistantMessage.content, ...finalUserMessage.content]
          }
          // 这里是故意将上条助手消息的内容（包含图片和文件）作为用户消息发送
          userMessage = [{ ...finalAssistantMessage, role: 'user' } as OpenAI.Responses.EasyInputMessage]
        }

        // 4. 最终请求消息
        let reqMessages: OpenAI.Responses.ResponseInput
        if (!systemMessage.content) {
          reqMessages = [...userMessage]
        } else {
          reqMessages = [systemMessage, ...userMessage].filter(Boolean) as OpenAI.Responses.EasyInputMessage[]
        }

        if (enableWebSearch) {
          tools.push({
            type: 'web_search_preview'
          })
        }

        if (enableGenerateImage) {
          tools.push({
            type: 'image_generation',
            partial_images: streamOutput ? 2 : undefined
          })
        }

        const toolChoices: OpenAI.Responses.ToolChoiceTypes = {
          type: 'web_search_preview'
        }

        tools = tools.concat(extraTools)
        const commonParams = {
          model: model.id,
          input:
            isRecursiveCall && recursiveSdkMessages && recursiveSdkMessages.length > 0
              ? recursiveSdkMessages
              : reqMessages,
          temperature: this.getTemperature(assistant, model),
          top_p: this.getTopP(assistant, model),
          max_output_tokens: maxTokens,
          stream: streamOutput,
          tools: !isEmpty(tools) ? tools : undefined,
          tool_choice: enableWebSearch ? toolChoices : undefined,
          service_tier: this.getServiceTier(model),
          ...(this.getReasoningEffort(assistant, model) as OpenAI.Reasoning),
          ...this.getCustomParameters(assistant)
        }
        const sdkParams: OpenAIResponseSdkParams = streamOutput
          ? {
              ...commonParams,
              stream: true
            }
          : {
              ...commonParams,
              stream: false
            }
        const timeout = this.getTimeout(model)
        return { payload: sdkParams, messages: reqMessages, metadata: { timeout } }
      }
    }
  }

  getResponseChunkTransformer(): ResponseChunkTransformer<OpenAIResponseSdkRawChunk> {
    const toolCalls: OpenAIResponseSdkToolCall[] = []
    const outputItems: OpenAI.Responses.ResponseOutputItem[] = []
    return () => ({
      async transform(chunk: OpenAIResponseSdkRawChunk, controller: TransformStreamDefaultController<GenericChunk>) {
        // 处理chunk
        if ('output' in chunk) {
          for (const output of chunk.output) {
            switch (output.type) {
              case 'message':
                if (output.content[0].type === 'output_text') {
                  controller.enqueue({
                    type: ChunkType.TEXT_DELTA,
                    text: output.content[0].text
                  })
                  if (output.content[0].annotations && output.content[0].annotations.length > 0) {
                    controller.enqueue({
                      type: ChunkType.LLM_WEB_SEARCH_COMPLETE,
                      llm_web_search: {
                        source: WebSearchSource.OPENAI_RESPONSE,
                        results: output.content[0].annotations
                      }
                    })
                  }
                }
                break
              case 'reasoning':
                controller.enqueue({
                  type: ChunkType.THINKING_DELTA,
                  text: output.summary.map((s) => s.text).join('\n')
                })
                break
              case 'function_call':
                toolCalls.push(output)
                break
              case 'image_generation_call':
                controller.enqueue({
                  type: ChunkType.IMAGE_CREATED
                })
                controller.enqueue({
                  type: ChunkType.IMAGE_COMPLETE,
                  image: {
                    type: 'base64',
                    images: [`data:image/png;base64,${output.result}`]
                  }
                })
            }
          }
        } else {
          switch (chunk.type) {
            case 'response.output_item.added':
              if (chunk.item.type === 'function_call') {
                outputItems.push(chunk.item)
              }
              break
            case 'response.reasoning_summary_text.delta':
              controller.enqueue({
                type: ChunkType.THINKING_DELTA,
                text: chunk.delta
              })
              break
            case 'response.image_generation_call.generating':
              controller.enqueue({
                type: ChunkType.IMAGE_CREATED
              })
              break
            case 'response.image_generation_call.partial_image':
              controller.enqueue({
                type: ChunkType.IMAGE_DELTA,
                image: {
                  type: 'base64',
                  images: [`data:image/png;base64,${chunk.partial_image_b64}`]
                }
              })
              break
            case 'response.image_generation_call.completed':
              controller.enqueue({
                type: ChunkType.IMAGE_COMPLETE
              })
              break
            case 'response.output_text.delta': {
              controller.enqueue({
                type: ChunkType.TEXT_DELTA,
                text: chunk.delta
              })
              break
            }
            case 'response.function_call_arguments.done': {
              const outputItem: OpenAI.Responses.ResponseOutputItem | undefined = outputItems.find(
                (item) => item.id === chunk.item_id
              )
              if (outputItem) {
                if (outputItem.type === 'function_call') {
                  toolCalls.push({
                    ...outputItem,
                    arguments: chunk.arguments
                  })
                }
              }
              break
            }
            case 'response.content_part.done': {
              if (chunk.part.type === 'output_text' && chunk.part.annotations && chunk.part.annotations.length > 0) {
                controller.enqueue({
                  type: ChunkType.LLM_WEB_SEARCH_COMPLETE,
                  llm_web_search: {
                    source: WebSearchSource.OPENAI_RESPONSE,
                    results: chunk.part.annotations
                  }
                })
              }
              if (toolCalls.length > 0) {
                controller.enqueue({
                  type: ChunkType.MCP_TOOL_CREATED,
                  tool_calls: toolCalls
                })
              }
              break
            }
            case 'response.completed': {
              const completion_tokens = chunk.response.usage?.output_tokens || 0
              const total_tokens = chunk.response.usage?.total_tokens || 0
              controller.enqueue({
                type: ChunkType.LLM_RESPONSE_COMPLETE,
                response: {
                  usage: {
                    prompt_tokens: chunk.response.usage?.input_tokens || 0,
                    completion_tokens: completion_tokens,
                    total_tokens: total_tokens
                  }
                }
              })
              break
            }
            case 'error': {
              controller.enqueue({
                type: ChunkType.ERROR,
                error: {
                  message: chunk.message,
                  code: chunk.code
                }
              })
              break
            }
          }
        }
      }
    })
  }
}
