import { AutomataKey } from '@shared/IpcChannel'
import { FC } from 'react'

interface Props {
  disabled: boolean
  sendMessage: () => void
}

const SendMessageButton: FC<Props> = ({ disabled, sendMessage }) => {
  return (
    <i
      className={`iconfont icon-ic_send ${AutomataKey.ClickableSendChatMessage}`}
      onClick={sendMessage}
      style={{
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? 'var(--color-text-3)' : 'var(--color-primary)',
        fontSize: 22,
        transition: 'all 0.2s',
        marginRight: 2
      }}
    />
  )
}

export default SendMessageButton
