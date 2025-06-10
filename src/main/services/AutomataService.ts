import express from 'express'
import { BrowserWindow } from 'electron'
import { AutomataKey, IpcChannel } from '@shared/IpcChannel'
import { ConfigKeys, configManager } from './ConfigManager'
import { Server } from 'http'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class AutomataService {
  app: express.Application
  server: Server | null = null

  message: string = ''
  isError: boolean = false

  constructor(mainWindow: BrowserWindow) {
    this.app = express()
    this.app.use(express.json())
    this.app.post('/api/assistant/trigger', async (req, res) => {
      const secret = configManager.getHTTPTriggerSecret()
      if (!secret) {
        res.status(400).json({ error: 'secret is not configured, go to settings to configure' })
        return
      }
      if (req.body.secret !== secret) {
        res.status(400).json({ error: 'secret is incorrect' })
        return
      }
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

    this.start()

    configManager.subscribe(ConfigKeys.HTTPTriggerHost, (_) => {
      this.start()
    })
    configManager.subscribe(ConfigKeys.HTTPTriggerPort, (_) => {
      this.start()
    })
  }

  isListening(): boolean {
    return this.server !== null && this.server.listening
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server && this.server.listening) {
        this.server.close((error) => {
          if (error) {
            console.error('Error stopping AutomataService:', error)
            reject(error)
          } else {
            console.log('AutomataService stopped')
            this.server = null
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
  }

  async start() {
    // Stop existing server if it's running
    if (this.isListening()) {
      console.log('Stopping existing AutomataService...')
      await this.stop()
    }

    const port = configManager.getHTTPTriggerPort()
    const host = configManager.getHTTPTriggerHost()

    this.server = this.app.listen(port, host, (error) => {
      if (error) {
        this.message = `Failed to start AutomataService on ${host}:${port}`
        this.isError = true
        console.log(this.message)
      } else {
        this.message = `AutomataService is running on ${host}:${port}`
        this.isError = false
        console.log(this.message)
      }
    })
  }
}
