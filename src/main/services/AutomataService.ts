import express from 'express'
import { BrowserWindow } from 'electron'
import { AutomataKey, IpcChannel } from '@shared/IpcChannel'
import { configManager } from './ConfigManager'
import { Server } from 'http'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface TriggerRequest {
  assistantId: string
  text: string
}

interface TriggerQuery {
  secret?: string
}

export class AutomataService {
  app: express.Application
  server: Server | null = null

  message: string = ''
  isError: boolean = false

  // 用于确保操作的原子性和互斥访问
  private isOperationInProgress: boolean = false
  private pendingOperation: Promise<void> | null = null

  constructor(mainWindow: BrowserWindow) {
    this.app = express()
    this.app.use(express.json())
    this.app.post('/api/assistant/trigger', async (req: express.Request<{}, {}, TriggerRequest, TriggerQuery>, res) => {
      const secret = configManager.getHTTPTriggerSecret()
      if (secret && req.query.secret !== secret) {
        res.status(400).json({ success: false, error: 'secret is incorrect' })
        return
      }
      if (!req.body.assistantId) {
        res.status(400).json({ success: false, error: 'assistantId is required' })
        return
      }
      if (!req.body.text) {
        res.status(400).json({ success: false, error: 'text is required' })
        return
      }

      // Wait for any ongoing operations to complete
      while (this.isOperationInProgress && this.pendingOperation) {
        await this.pendingOperation
      }

      // Set mutex flags to prevent concurrent operations
      this.isOperationInProgress = true
      this.pendingOperation = this._handleTriggerRequest(req.body, mainWindow)

      try {
        await this.pendingOperation
        res.status(200).json({ success: true, message: 'success' })
      } catch (error) {
        console.error('AutomataService error:', error)
        res.status(500).json({ success: false, error: 'Internal server error' })
      } finally {
        // Clear mutex flags
        this.isOperationInProgress = false
        this.pendingOperation = null
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
      await new Promise<void>((resolve, reject) => {
        this.server!.close((error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
      this.server = null
    }
  }

  async reconfigure(): Promise<void> {
    // 如果已经有一个操作在进行中，等待它完成
    while (this.isOperationInProgress && this.pendingOperation) {
      await this.pendingOperation
    }

    if (this.isOperationInProgress) {
      return
    }

    // 设置操作标志并创建 Promise
    this.isOperationInProgress = true
    this.pendingOperation = this._reconfigure()

    try {
      await this.pendingOperation
    } finally {
      // 确保无论成功还是失败都清理状态
      this.isOperationInProgress = false
      this.pendingOperation = null
    }
  }

  private async _handleTriggerRequest(body: TriggerRequest, mainWindow: BrowserWindow): Promise<void> {
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
        data: { key: AutomataKey.ClickableAssistantPrefix + body.assistantId }
      },
      // 输入框
      {
        channel: IpcChannel.Automata_UpdateTextarea,
        data: { key: AutomataKey.InputChatMessage, text: body.text }
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
      this.server = this.app.listen(port, host, (error?: Error) => {
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
