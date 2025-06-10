import express from 'express'
import { BrowserWindow } from 'electron'
import { AutomataKey, IpcChannel } from '@shared/IpcChannel'
import { configManager } from './ConfigManager'
import { Server } from 'http'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class AutomataService {
  app: express.Application
  server: Server | null = null

  message: string = ''
  isError: boolean = false

  // 用于确保 reconfigure 方法的原子性
  private isReconfiguring: boolean = false
  private pendingReconfigure: Promise<void> | null = null

  constructor(mainWindow: BrowserWindow) {
    this.app = express()
    this.app.use(express.json())
    this.app.post('/api/assistant/trigger', async (req, res) => {
      const secret = configManager.getHTTPTriggerSecret()
      if (secret && req.query.secret !== secret) {
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
          await delay(200)
        }
        res.status(200).json({ message: 'success' })
      } catch (error) {
        console.error('AutomataService error:', error)
        res.status(500).json({ error: 'Internal server error' })
      }
    })

    this.reconfigure()
  }

  getStatus() {
    return { message: this.message, isError: this.isError }
  }

  getConfig() {
    return {
      enabled: configManager.getHTTPTriggerEnabled(),
      host: configManager.getHTTPTriggerHost(),
      port: configManager.getHTTPTriggerPort(),
      secret: configManager.getHTTPTriggerSecret()
    }
  }

  setConfig(config: { enabled: boolean; host: string; port: number; secret: string }) {
    configManager.setHTTPTriggerEnabled(config.enabled)
    configManager.setHTTPTriggerHost(config.host)
    configManager.setHTTPTriggerPort(config.port)
    configManager.setHTTPTriggerSecret(config.secret)
    this.reconfigure()
  }

  isListening(): boolean {
    return this.server !== null && this.server.listening
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise((resolve) => this.server!.close(resolve))
      this.server = null
    }
  }

  async reconfigure(): Promise<void> {
    // 如果已经有一个重配置操作在进行中，等待它完成
    if (this.isReconfiguring) {
      if (this.pendingReconfigure) {
        await this.pendingReconfigure
      }
      return
    }

    // 设置重配置标志并创建 Promise
    this.isReconfiguring = true
    this.pendingReconfigure = this._reconfigure()

    try {
      await this.pendingReconfigure
    } finally {
      // 确保无论成功还是失败都清理状态
      this.isReconfiguring = false
      this.pendingReconfigure = null
    }
  }

  private async _reconfigure(): Promise<void> {
    if (this.isListening()) {
      await this.stop()
    }

    this.isError = false
    this.message = 'server stopped'

    if (!configManager.getHTTPTriggerEnabled()) {
      return
    }

    const port = configManager.getHTTPTriggerPort()
    const host = configManager.getHTTPTriggerHost()

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, host, (error) => {
        if (error) {
          this.message = `Failed to start server on ${host}:${port}: ${error.message}`
          this.isError = true
          reject(error)
        } else {
          this.message = `Server is running on ${host}:${port}`
          this.isError = false
          resolve()
        }
      })
    })
  }
}
