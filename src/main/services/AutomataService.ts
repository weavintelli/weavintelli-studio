import express from 'express'
import { BrowserWindow } from 'electron'
import { AutomataKey, IpcChannel } from '@shared/IpcChannel'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class AutomataService {
  app: express.Application

  constructor(mainWindow: BrowserWindow) {
    this.app = express()
    this.app.use(express.json())
    this.app.post('/api/assistant/trigger', async (req, res) => {
      if (!req.body.assistantId) {
        res.status(400).json({ error: 'assistantId is required' })
        return
      }
      if (!req.body.text) {
        res.status(400).json({ error: 'text is required' })
        return
      }

      try {
        for (const action of [
          // 左边栏
          {
            channel: IpcChannel.Automata_Click,
            data: { key: AutomataKey.ClickableSidebarPrefix + 'assistants' }
          },
          // 左边栏，二次确认，用于自动关闭弹窗
          {
            channel: IpcChannel.Automata_Click,
            data: { key: AutomataKey.ClickableSidebarPrefix + 'assistants' }
          },
          // 次顶部标签页
          {
            channel: IpcChannel.Automata_Click,
            data: { key: AutomataKey.ClickableTabbarAssistants }
          },
          // 次左侧助手
          {
            channel: IpcChannel.Automata_Click,
            data: { key: AutomataKey.ClickableAssistantPrefix + req.body.assistantId }
          },
          // 输入框
          {
            channel: IpcChannel.Automata_UpdateTextarea,
            data: { key: AutomataKey.InputChatMessage, text: req.body.text }
          },
          // 发送按钮
          {
            channel: IpcChannel.Automata_Click,
            data: { key: AutomataKey.ClickableSendChatMessage }
          }
        ]) {
          mainWindow.webContents.send(action.channel, action.data)
          console.log('send', action.channel, action.data)
          await delay(200)
        }
        res.status(200).json({ message: 'success' })
      } catch (error) {
        console.error('AutomataService error:', error)
        res.status(500).json({ error: 'Internal server error' })
      }
    })
    this.app.listen(8866, () => {
      console.log('AutomataService is running on port 8866')
    })
  }
}
