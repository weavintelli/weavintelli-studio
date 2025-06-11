import Scrollbar from '@renderer/components/Scrollbar'
import { MessageEditingProvider } from '@renderer/context/MessageEditingContext'
import { useChatContext } from '@renderer/hooks/useChatContext'
import { useMessageOperations } from '@renderer/hooks/useMessageOperations'
import { useSettings } from '@renderer/hooks/useSettings'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { MultiModelMessageStyle } from '@renderer/store/settings'
import type { Topic } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { classNames } from '@renderer/utils'
import { Popover } from 'antd'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styled, { css } from 'styled-components'

import MessageItem from './Message'
import MessageGroupMenuBar from './MessageGroupMenuBar'
import SelectableMessage from './MessageSelect'

interface Props {
  messages: (Message & { index: number })[]
  topic: Topic
  registerMessageElement?: (id: string, element: HTMLElement | null) => void
}

const MessageGroup = ({ messages, topic, registerMessageElement }: Props) => {
  const { editMessage } = useMessageOperations(topic)
  const { multiModelMessageStyle: multiModelMessageStyleSetting, gridColumns, gridPopoverTrigger } = useSettings()
  const { isMultiSelectMode } = useChatContext(topic)

  const [multiModelMessageStyle, setMultiModelMessageStyle] = useState<MultiModelMessageStyle>(
    messages[0].multiModelMessageStyle || multiModelMessageStyleSetting
  )

  const messageLength = messages.length
  const prevMessageLengthRef = useRef(messageLength)
  const [selectedIndex, setSelectedIndex] = useState(messageLength - 1)

  const selectedMessageId = useMemo(() => {
    if (messages.length === 1) return messages[0]?.id
    const selectedMessage = messages.find((message) => message.foldSelected)
    if (selectedMessage) {
      return selectedMessage.id
    }
    return messages[0]?.id
  }, [messages])

  const setSelectedMessage = useCallback(
    (message: Message) => {
      // 前一个
      editMessage(selectedMessageId, { foldSelected: false })
      // 当前选中的消息
      editMessage(message.id, { foldSelected: true })

      setTimeout(() => {
        const messageElement = document.getElementById(`message-${message.id}`)
        if (messageElement) {
          messageElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
      }, 200)
    },
    [editMessage, selectedMessageId]
  )

  const isGrouped = isMultiSelectMode ? false : messageLength > 1 && messages.every((m) => m.role === 'assistant')
  const isHorizontal = multiModelMessageStyle === 'horizontal'
  const isGrid = multiModelMessageStyle === 'grid'

  useEffect(() => {
    if (messageLength > prevMessageLengthRef.current) {
      setSelectedIndex(messageLength - 1)
      const lastMessage = messages[messageLength - 1]
      if (lastMessage) {
        setSelectedMessage(lastMessage)
      }
    } else {
      const newIndex = messages.findIndex((msg) => msg.id === selectedMessageId)
      if (newIndex !== -1) {
        setSelectedIndex(newIndex)
      }
    }
    prevMessageLengthRef.current = messageLength
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageLength])

  // 添加对流程图节点点击事件的监听
  useEffect(() => {
    // 只在组件挂载和消息数组变化时添加监听器
    if (!isGrouped || messageLength <= 1) return

    const handleFlowNavigate = (event: CustomEvent) => {
      const { messageId } = event.detail

      // 查找对应的消息在当前消息组中的索引
      const targetIndex = messages.findIndex((msg) => msg.id === messageId)

      // 如果找到消息且不是当前选中的索引，则切换标签
      if (targetIndex !== -1 && targetIndex !== selectedIndex) {
        setSelectedIndex(targetIndex)

        // 使用setSelectedMessage函数来切换标签，这是处理foldSelected的关键
        const targetMessage = messages[targetIndex]
        if (targetMessage) {
          setSelectedMessage(targetMessage)
        }
      }
    }

    // 添加事件监听器
    document.addEventListener('flow-navigate-to-message', handleFlowNavigate as EventListener)

    // 清理函数
    return () => {
      document.removeEventListener('flow-navigate-to-message', handleFlowNavigate as EventListener)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, selectedIndex, isGrouped, messageLength])

  // 添加对LOCATE_MESSAGE事件的监听
  useEffect(() => {
    // 为每个消息注册一个定位事件监听器
    const eventHandlers: { [key: string]: () => void } = {}

    messages.forEach((message) => {
      const eventName = EVENT_NAMES.LOCATE_MESSAGE + ':' + message.id
      const handler = () => {
        // 检查消息是否处于可见状态
        const element = document.getElementById(`message-${message.id}`)
        if (element) {
          const display = window.getComputedStyle(element).display

          if (display === 'none') {
            // 如果消息隐藏，先切换标签
            setSelectedMessage(message)
          } else {
            // 直接滚动
            element.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        }
      }

      eventHandlers[eventName] = handler
      EventEmitter.on(eventName, handler)
    })

    // 清理函数
    return () => {
      // 移除所有事件监听器
      Object.entries(eventHandlers).forEach(([eventName, handler]) => {
        EventEmitter.off(eventName, handler)
      })
    }
  }, [messages, setSelectedMessage])

  useEffect(() => {
    messages.forEach((message) => {
      const element = document.getElementById(`message-${message.id}`)
      element && registerMessageElement?.(message.id, element)
    })
    return () => messages.forEach((message) => registerMessageElement?.(message.id, null))
  }, [messages, registerMessageElement])

  const renderMessage = useCallback(
    (message: Message & { index: number }) => {
      const isGridGroupMessage = isGrid && message.role === 'assistant' && isGrouped
      const messageProps = {
        isGrouped,
        message,
        topic,
        index: message.index,
        style: {
          paddingTop: isGrouped && ['horizontal', 'grid'].includes(multiModelMessageStyle) ? 0 : 15
        }
      }

      const messageContent = (
        <MessageWrapper
          id={`message-${message.id}`}
          $layout={multiModelMessageStyle}
          // $selected={index === selectedIndex}
          $isGrouped={isGrouped}
          key={message.id}
          className={classNames({
            // 加个卡片布局
            'group-message-wrapper': message.role === 'assistant' && (isHorizontal || isGrid) && isGrouped,
            [multiModelMessageStyle]: isGrouped,
            selected: message.id === selectedMessageId
          })}>
          <MessageItem {...messageProps} />
        </MessageWrapper>
      )

      if (isGridGroupMessage) {
        return (
          <Popover
            key={message.id}
            content={
              <MessageWrapper
                $layout={multiModelMessageStyle}
                // $selected={index === selectedIndex}
                $isGrouped={isGrouped}
                $isInPopover={true}>
                <MessageItem {...messageProps} />
              </MessageWrapper>
            }
            trigger={gridPopoverTrigger}
            styles={{ root: { maxWidth: '60vw', minWidth: '550px', overflowY: 'auto', zIndex: 1000 } }}>
            <div style={{ cursor: 'pointer' }}>{messageContent}</div>
          </Popover>
        )
      }

      return (
        <SelectableMessage
          key={`selectable-${message.id}`}
          messageId={message.id}
          topic={topic}
          isClearMessage={message.type === 'clear'}>
          {messageContent}
        </SelectableMessage>
      )
    },
    [isGrid, isGrouped, topic, multiModelMessageStyle, isHorizontal, selectedMessageId, gridPopoverTrigger]
  )

  return (
    <MessageEditingProvider>
      <GroupContainer
        id={`message-group-${messages[0].askId}`}
        $isGrouped={isGrouped}
        $layout={multiModelMessageStyle}
        className={classNames([isGrouped && 'group-container', isHorizontal && 'horizontal', isGrid && 'grid'])}>
        <GridContainer
          $count={messageLength}
          $layout={multiModelMessageStyle}
          $gridColumns={gridColumns}
          className={classNames([isGrouped && 'group-grid-container', isHorizontal && 'horizontal', isGrid && 'grid'])}>
          {messages.map(renderMessage)}
        </GridContainer>
        {isGrouped && (
          <MessageGroupMenuBar
            multiModelMessageStyle={multiModelMessageStyle}
            setMultiModelMessageStyle={(style) => {
              setMultiModelMessageStyle(style)
              messages.forEach((message) => {
                editMessage(message.id, { multiModelMessageStyle: style })
              })
            }}
            messages={messages}
            selectMessageId={selectedMessageId}
            setSelectedMessage={setSelectedMessage}
            topic={topic}
          />
        )}
      </GroupContainer>
    </MessageEditingProvider>
  )
}

const GroupContainer = styled.div<{ $isGrouped: boolean; $layout: MultiModelMessageStyle }>`
  padding-top: ${({ $isGrouped, $layout }) => ($isGrouped && 'horizontal' === $layout ? '15px' : '0')};
  &.group-container.horizontal,
  &.group-container.grid {
    padding: 0 20px;
    .message {
      padding: 0;
    }
    .group-menu-bar {
      margin-left: 0;
      margin-right: 0;
    }
  }
`

const GridContainer = styled.div<{ $count: number; $layout: MultiModelMessageStyle; $gridColumns: number }>`
  width: 100%;
  display: grid;
  gap: ${({ $layout }) => ($layout === 'horizontal' ? '16px' : '0')};
  grid-template-columns: repeat(
    ${({ $layout, $count }) => (['fold', 'vertical'].includes($layout) ? 1 : $count)},
    minmax(480px, 1fr)
  );
  @media (max-width: 800px) {
    grid-template-columns: repeat(
      ${({ $layout, $count }) => (['fold', 'vertical'].includes($layout) ? 1 : $count)},
      minmax(400px, 1fr)
    );
  }
  ${({ $layout }) =>
    $layout === 'horizontal' &&
    css`
      margin-top: 15px;
    `}
  ${({ $gridColumns, $layout, $count }) =>
    $layout === 'grid' &&
    css`
      margin-top: 15px;
      grid-template-columns: repeat(${$count > 1 ? $gridColumns || 2 : 1}, minmax(0, 1fr));
      grid-template-rows: auto;
      gap: 16px;
    `}
  ${({ $layout }) => {
    return $layout === 'horizontal'
      ? css`
          overflow-y: auto;
        `
      : 'overflow-y: visible;'
  }}
`

interface MessageWrapperProps {
  $layout: 'fold' | 'horizontal' | 'vertical' | 'grid'
  // $selected: boolean
  $isGrouped: boolean
  $isInPopover?: boolean
}

const MessageWrapper = styled(Scrollbar)<MessageWrapperProps>`
  width: 100%;
  display: flex;

  &.horizontal {
    display: inline-block;
  }
  &.grid {
    display: inline-block;
  }
  &.fold {
    display: none;
    &.selected {
      display: inline-block;
    }
  }

  ${({ $layout, $isGrouped }) => {
    if ($layout === 'horizontal' && $isGrouped) {
      return css`
        border: 0.5px solid var(--color-border);
        padding: 10px;
        border-radius: 6px;
        max-height: 600px;
        margin-bottom: 10px;
      `
    }
    return ''
  }}

  ${({ $layout, $isInPopover, $isGrouped }) => {
    // 如果布局是grid，并且是组消息，则设置最大高度和溢出行为（卡片不可滚动，点击展开后可滚动）
    // 如果布局是horizontal，则设置溢出行为（卡片可滚动）
    // 如果布局是fold、vertical，高度不限制，与正常消息流布局一致，则设置卡片不可滚动（visible）
    return $layout === 'grid' && $isGrouped
      ? css`
          max-height: ${$isInPopover ? '50vh' : '300px'};
          overflow-y: ${$isInPopover ? 'auto' : 'hidden'};
          border: 0.5px solid ${$isInPopover ? 'transparent' : 'var(--color-border)'};
          padding: 10px;
          border-radius: 6px;
          background-color: var(--color-background);
        `
      : css`
          overflow-y: ${$layout === 'horizontal' ? 'auto' : 'visible'};
          border-radius: 6px;
        `
  }}
`

export default memo(MessageGroup)
