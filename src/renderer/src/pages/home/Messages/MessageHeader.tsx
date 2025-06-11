import EmojiAvatar from '@renderer/components/Avatar/EmojiAvatar'
import UserPopup from '@renderer/components/Popups/UserPopup'
import { APP_NAME, AppLogo, isLocalAi } from '@renderer/config/env'
import { getModelLogo } from '@renderer/config/models'
import { useTheme } from '@renderer/context/ThemeProvider'
import useAvatar from '@renderer/hooks/useAvatar'
import { useMinappPopup } from '@renderer/hooks/useMinappPopup'
import { useMessageStyle, useSettings } from '@renderer/hooks/useSettings'
import { getMessageModelId } from '@renderer/services/MessagesService'
import { getModelName } from '@renderer/services/ModelService'
import type { Assistant, Model } from '@renderer/types'
import type { Message } from '@renderer/types/newMessage'
import { firstLetter, isEmoji, removeLeadingEmoji } from '@renderer/utils'
import { Avatar } from 'antd'
import dayjs from 'dayjs'
import { CSSProperties, FC, memo, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import MessageTokens from './MessageTokens'

interface Props {
  message: Message
  assistant: Assistant
  model?: Model
  index: number | undefined
}

const getAvatarSource = (isLocalAi: boolean, modelId: string | undefined) => {
  if (isLocalAi) return AppLogo
  return modelId ? getModelLogo(modelId) : undefined
}

const MessageHeader: FC<Props> = memo(({ assistant, model, message, index }) => {
  const avatar = useAvatar()
  const { theme } = useTheme()
  const { userName, sidebarIcons } = useSettings()
  const { t } = useTranslation()
  const { isBubbleStyle } = useMessageStyle()
  const { openMinappById } = useMinappPopup()

  const avatarSource = useMemo(() => getAvatarSource(isLocalAi, getMessageModelId(message)), [message])

  const getUserName = useCallback(() => {
    if (isLocalAi && message.role !== 'user') {
      return APP_NAME
    }

    if (message.role === 'assistant') {
      return getModelName(model) || getMessageModelId(message) || ''
    }

    return userName || t('common.you')
  }, [message, model, t, userName])

  const isAssistantMessage = message.role === 'assistant'
  const showMinappIcon = sidebarIcons.visible.includes('minapp')
  const { showTokens } = useSettings()

  const avatarName = useMemo(() => firstLetter(assistant?.name).toUpperCase(), [assistant?.name])
  const username = useMemo(() => removeLeadingEmoji(getUserName()), [getUserName])
  const isLastMessage = index === 0

  const showMiniApp = useCallback(() => {
    showMinappIcon && model?.provider && openMinappById(model.provider)
    // because don't need openMinappById to be a dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.provider, showMinappIcon])

  const avatarStyle: CSSProperties | undefined = isBubbleStyle
    ? {
        flexDirection: isAssistantMessage ? 'row' : 'row-reverse',
        textAlign: isAssistantMessage ? 'left' : 'right'
      }
    : undefined

  const containerStyle = isBubbleStyle
    ? {
        justifyContent: isAssistantMessage ? 'flex-start' : 'flex-end'
      }
    : undefined

  return (
    <Container className="message-header" style={containerStyle}>
      <AvatarWrapper style={avatarStyle}>
        {isAssistantMessage ? (
          <Avatar
            src={avatarSource}
            size={35}
            style={{
              borderRadius: '25%',
              cursor: showMinappIcon ? 'pointer' : 'default',
              border: isLocalAi ? '1px solid var(--color-border-soft)' : 'none',
              filter: theme === 'dark' ? 'invert(0.05)' : undefined
            }}
            onClick={showMiniApp}>
            {avatarName}
          </Avatar>
        ) : (
          <>
            {isEmoji(avatar) ? (
              <EmojiAvatar onClick={() => UserPopup.show()} size={35} fontSize={20}>
                {avatar}
              </EmojiAvatar>
            ) : (
              <Avatar
                src={avatar}
                size={35}
                style={{ borderRadius: '25%', cursor: 'pointer' }}
                onClick={() => UserPopup.show()}
              />
            )}
          </>
        )}
        <UserWrap>
          <UserName isBubbleStyle={isBubbleStyle} theme={theme}>
            {username}
          </UserName>
          <InfoWrap
            style={{
              flexDirection: !isAssistantMessage && isBubbleStyle ? 'row-reverse' : undefined
            }}>
            <MessageTime>{dayjs(message?.updatedAt ?? message.createdAt).format('MM/DD HH:mm')}</MessageTime>
            {showTokens && <DividerContainer style={{ color: 'var(--color-text-3)' }}> | </DividerContainer>}
            <MessageTokens message={message} isLastMessage={isLastMessage} />
          </InfoWrap>
        </UserWrap>
      </AvatarWrapper>
    </Container>
  )
})

MessageHeader.displayName = 'MessageHeader'

const Container = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  padding-bottom: 4px;
`

const AvatarWrapper = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
`

const UserWrap = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: space-between;
`

const InfoWrap = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
`

const DividerContainer = styled.div`
  font-size: 10px;
  color: var(--color-text-3);
  margin: 0 2px;
`

const UserName = styled.div<{ isBubbleStyle?: boolean; theme?: string }>`
  font-size: 14px;
  font-weight: 600;
  color: ${(props) => (props.isBubbleStyle && props.theme === 'dark' ? 'white' : 'var(--color-text)')};
`

const MessageTime = styled.div`
  font-size: 10px;
  color: var(--color-text-3);
`

export default MessageHeader
