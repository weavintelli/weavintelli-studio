import ContextMenu from '@renderer/components/ContextMenu'
import { useMessageEditing } from '@renderer/context/MessageEditingContext'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useMessageOperations } from '@renderer/hooks/useMessageOperations'
import { useModel } from '@renderer/hooks/useModel'
import { useMessageStyle, useSettings } from '@renderer/hooks/useSettings'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { getMessageModelId } from '@renderer/services/MessagesService'
import { getModelUniqId } from '@renderer/services/ModelService'
import { estimateMessageUsage } from '@renderer/services/TokenService'
import { Assistant, Topic } from '@renderer/types'
import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { classNames } from '@renderer/utils'
import { Divider } from 'antd'
import React, { Dispatch, FC, memo, SetStateAction, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import MessageContent from './MessageContent'
import MessageEditor from './MessageEditor'
import MessageErrorBoundary from './MessageErrorBoundary'
import MessageHeader from './MessageHeader'
import MessageMenubar from './MessageMenubar'

interface Props {
  message: Message
  topic: Topic
  assistant?: Assistant
  index?: number
  total?: number
  hideMenuBar?: boolean
  style?: React.CSSProperties
  isGrouped?: boolean
  isStreaming?: boolean
  onSetMessages?: Dispatch<SetStateAction<Message[]>>
}

const MessageItem: FC<Props> = ({
  message,
  topic,
  // assistant,
  index,
  hideMenuBar = false,
  isGrouped,
  isStreaming = false,
  style
}) => {
  const { t } = useTranslation()
  const { assistant, setModel } = useAssistant(message.assistantId)
  const model = useModel(getMessageModelId(message), message.model?.provider) || message.model
  const { isBubbleStyle } = useMessageStyle()
  const { showMessageDivider, messageFont, fontSize, narrowMode, messageStyle } = useSettings()
  const { editMessageBlocks, resendUserMessageWithEdit, editMessage } = useMessageOperations(topic)
  const messageContainerRef = useRef<HTMLDivElement>(null)
  const { editingMessageId, stopEditing } = useMessageEditing()
  const isEditing = editingMessageId === message.id

  useEffect(() => {
    if (isEditing && messageContainerRef.current) {
      messageContainerRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      })
    }
  }, [isEditing])

  const handleEditSave = useCallback(
    async (blocks: MessageBlock[]) => {
      try {
        await editMessageBlocks(message.id, blocks)
        const usage = await estimateMessageUsage(message)
        editMessage(message.id, { usage: usage })
        stopEditing()
      } catch (error) {
        console.error('Failed to save message blocks:', error)
      }
    },
    [message, editMessageBlocks, stopEditing, editMessage]
  )

  const handleEditResend = useCallback(
    async (blocks: MessageBlock[]) => {
      const assistantWithTopicPrompt = topic.prompt
        ? { ...assistant, prompt: `${assistant.prompt}\n${topic.prompt}` }
        : assistant
      try {
        await resendUserMessageWithEdit(message, blocks, assistantWithTopicPrompt)
        stopEditing()
      } catch (error) {
        console.error('Failed to resend message:', error)
      }
    },
    [message, resendUserMessageWithEdit, assistant, stopEditing, topic.prompt]
  )

  const handleEditCancel = useCallback(() => {
    stopEditing()
  }, [stopEditing])

  const isLastMessage = index === 0
  const isAssistantMessage = message.role === 'assistant'
  const showMenubar = !hideMenuBar && !isStreaming && !message.status.includes('ing') && !isEditing

  const messageBorder = !isBubbleStyle && showMessageDivider ? '1px dotted var(--color-border)' : 'none'
  const messageBackground = getMessageBackground(isBubbleStyle, isAssistantMessage)

  const messageHighlightHandler = useCallback((highlight: boolean = true) => {
    if (messageContainerRef.current) {
      messageContainerRef.current.scrollIntoView({ behavior: 'smooth' })
      if (highlight) {
        setTimeout(() => {
          const classList = messageContainerRef.current?.classList
          classList?.add('message-highlight')
          setTimeout(() => classList?.remove('message-highlight'), 2500)
        }, 500)
      }
    }
  }, [])

  useEffect(() => {
    const unsubscribes = [EventEmitter.on(EVENT_NAMES.LOCATE_MESSAGE + ':' + message.id, messageHighlightHandler)]
    return () => unsubscribes.forEach((unsub) => unsub())
  }, [message.id, messageHighlightHandler])

  if (message.type === 'clear') {
    return (
      <NewContextMessage className="clear-context-divider" onClick={() => EventEmitter.emit(EVENT_NAMES.NEW_CONTEXT)}>
        <Divider dashed style={{ padding: '0 20px' }} plain>
          {t('chat.message.new.context')}
        </Divider>
      </NewContextMessage>
    )
  }

  return (
    <MessageContainer
      key={message.id}
      className={classNames({
        message: true,
        'message-assistant': isAssistantMessage,
        'message-user': !isAssistantMessage
      })}
      ref={messageContainerRef}
      style={{
        ...style,
        justifyContent: isBubbleStyle ? (isAssistantMessage ? 'flex-start' : 'flex-end') : undefined,
        flex: isBubbleStyle ? undefined : 1
      }}>
      {isEditing && (
        <ContextMenu
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignSelf: isAssistantMessage ? 'flex-start' : 'flex-end',
            width: isBubbleStyle ? '70%' : '100%'
          }}>
          <MessageHeader
            message={message}
            assistant={assistant}
            model={model}
            key={getModelUniqId(model)}
            index={index}
          />
          <div style={{ paddingLeft: messageStyle === 'plain' ? 46 : undefined }}>
            <MessageEditor
              message={message}
              onSave={handleEditSave}
              onResend={handleEditResend}
              onCancel={handleEditCancel}
            />
          </div>
        </ContextMenu>
      )}
      {!isEditing && (
        <ContextMenu
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignSelf: isAssistantMessage ? 'flex-start' : 'flex-end',
            flex: 1,
            maxWidth: '100%'
          }}>
          <MessageHeader
            message={message}
            assistant={assistant}
            model={model}
            key={getModelUniqId(model)}
            index={index}
          />
          <MessageContentContainer
            className={
              message.role === 'user'
                ? 'message-content-container message-content-container-user'
                : message.role === 'assistant'
                  ? 'message-content-container message-content-container-assistant'
                  : 'message-content-container'
            }
            style={{
              fontFamily: messageFont === 'serif' ? 'var(--font-family-serif)' : 'var(--font-family)',
              fontSize,
              background: messageBackground,
              overflowY: 'visible',
              maxWidth: narrowMode ? 760 : undefined,
              alignSelf: isBubbleStyle ? (isAssistantMessage ? 'start' : 'end') : undefined
            }}>
            <MessageErrorBoundary>
              <MessageContent message={message} />
            </MessageErrorBoundary>
            {showMenubar && !isBubbleStyle && (
              <MessageFooter
                className="MessageFooter"
                style={{
                  borderTop: messageBorder,
                  flexDirection: !isLastMessage ? 'row-reverse' : undefined
                }}>
                <MessageMenubar
                  message={message}
                  assistant={assistant}
                  model={model}
                  index={index}
                  topic={topic}
                  isLastMessage={isLastMessage}
                  isAssistantMessage={isAssistantMessage}
                  isGrouped={isGrouped}
                  messageContainerRef={messageContainerRef as React.RefObject<HTMLDivElement>}
                  setModel={setModel}
                />
              </MessageFooter>
            )}
          </MessageContentContainer>
          {showMenubar && isBubbleStyle && (
            <MessageFooter
              className="MessageFooter"
              style={{
                borderTop: messageBorder,
                flexDirection: !isAssistantMessage ? 'row-reverse' : undefined
              }}>
              <MessageMenubar
                message={message}
                assistant={assistant}
                model={model}
                index={index}
                topic={topic}
                isLastMessage={isLastMessage}
                isAssistantMessage={isAssistantMessage}
                isGrouped={isGrouped}
                messageContainerRef={messageContainerRef as React.RefObject<HTMLDivElement>}
                setModel={setModel}
              />
            </MessageFooter>
          )}
        </ContextMenu>
      )}
    </MessageContainer>
  )
}

const getMessageBackground = (isBubbleStyle: boolean, isAssistantMessage: boolean) => {
  return isBubbleStyle
    ? isAssistantMessage
      ? 'var(--chat-background-assistant)'
      : 'var(--chat-background-user)'
    : undefined
}

const MessageContainer = styled.div`
  display: flex;
  width: 100%;
  position: relative;
  transition: background-color 0.3s ease;
  padding: 0 20px;
  transform: translateZ(0);
  will-change: transform;
  &.message-highlight {
    background-color: var(--color-primary-mute);
  }
  .menubar {
    opacity: 0;
    transition: opacity 0.2s ease;
    transform: translateZ(0);
    will-change: opacity;
    &.show {
      opacity: 1;
    }
  }
  &:hover {
    .menubar {
      opacity: 1;
    }
  }
`

const MessageContentContainer = styled.div`
  max-width: 100%;
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: space-between;
  margin-left: 46px;
  margin-top: 5px;
  overflow-y: auto;
`

const MessageFooter = styled.div`
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
  margin-top: 2px;
  gap: 20px;
`

const NewContextMessage = styled.div`
  cursor: pointer;
  flex: 1;
`

export default memo(MessageItem)
