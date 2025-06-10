import { FC, useEffect, useState } from 'react'
import { useTheme } from '@renderer/context/ThemeProvider'
import { useTranslation } from 'react-i18next'
import { Button, Input, InputNumber, Switch, Typography, Space, Card, Descriptions } from 'antd'
import { SettingContainer, SettingTitle, SettingGroup, SettingDivider, SettingRow, SettingRowTitle } from '.'

const { Text } = Typography

interface AutomataConfig {
  enabled: boolean
  host: string
  port: number
  secret: string
}

interface AutomataStatus {
  message: string
  isError: boolean
}

const AutomataSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()

  const [config, setConfig] = useState<AutomataConfig>({
    enabled: false,
    host: '127.0.0.1',
    port: 3000,
    secret: ''
  })

  const [status, setStatus] = useState<AutomataStatus>({
    message: '',
    isError: false
  })

  const [loading, setLoading] = useState(false)

  // Load initial config and status
  useEffect(() => {
    loadConfig()
    loadStatus()
  }, [])

  const loadConfig = async () => {
    try {
      const automataConfig = await window.api.automata.getConfig()
      setConfig(automataConfig)
    } catch (error) {
      console.error('Failed to load automata config:', error)
    }
  }

  const loadStatus = async () => {
    try {
      const automataStatus = await window.api.automata.getStatus()
      setStatus(automataStatus)
    } catch (error) {
      console.error('Failed to load automata status:', error)
    }
  }

  const handleSave = async () => {
    setLoading(true)
    try {
      await window.api.automata.setConfig(config)
      // Reload status after setting config
      await loadStatus()
      window.message.success({ content: t('settings.automata.save.success'), key: 'automata-save' })
    } catch (error) {
      console.error('Failed to save automata config:', error)
      window.message.error({ content: t('settings.automata.save.error'), key: 'automata-save' })
    } finally {
      setLoading(false)
    }
  }

  const updateConfig = (field: keyof AutomataConfig, value: any) => {
    setConfig((prev) => ({
      ...prev,
      [field]: value
    }))
  }

  const generateCurlExample = () => {
    const baseUrl = `http://${config.host}:${config.port}/api/assistant/trigger`
    const queryParams = config.secret ? `?secret=${encodeURIComponent(config.secret)}` : ''
    const url = baseUrl + queryParams
    const jsonBody = {
      assistantId: 'default',
      text: 'Hello, world!'
    }

    return `curl -X POST "${url}" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(jsonBody, null, 2).replace(/\n/g, '\n  ')}'`
  }

  return (
    <SettingContainer theme={theme}>
      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.automata.title')}</SettingTitle>
        <SettingDivider />

        <SettingRow>
          <SettingRowTitle>{t('settings.automata.enabled')}</SettingRowTitle>
          <Switch checked={config.enabled} onChange={(checked) => updateConfig('enabled', checked)} />
        </SettingRow>

        <SettingDivider />

        <SettingRow>
          <SettingRowTitle>{t('settings.automata.host')}</SettingRowTitle>
          <Input
            value={config.host}
            onChange={(e) => updateConfig('host', e.target.value)}
            placeholder="127.0.0.1"
            style={{ width: 180 }}
          />
        </SettingRow>

        <SettingDivider />

        <SettingRow>
          <SettingRowTitle>{t('settings.automata.port')}</SettingRowTitle>
          <InputNumber
            value={config.port}
            onChange={(value) => updateConfig('port', value || 3000)}
            min={1}
            max={65535}
            style={{ width: 180 }}
          />
        </SettingRow>

        <SettingDivider />

        <SettingRow>
          <SettingRowTitle>{t('settings.automata.secret')}</SettingRowTitle>
          <Input.Password
            value={config.secret}
            onChange={(e) => updateConfig('secret', e.target.value)}
            placeholder={t('settings.automata.secret.placeholder')}
            style={{ width: 180 }}
          />
        </SettingRow>

        <SettingDivider />

        <SettingRow>
          <div></div>
          <Button type="primary" onClick={handleSave} loading={loading}>
            {t('common.save')}
          </Button>
        </SettingRow>
      </SettingGroup>

      {status.message && (
        <SettingGroup theme={theme}>
          <SettingTitle>{t('settings.automata.status')}</SettingTitle>
          <SettingDivider />
          <SettingRow>
            <Text type={status.isError ? 'danger' : 'success'}>{status.message}</Text>
          </SettingRow>
        </SettingGroup>
      )}

      <SettingGroup theme={theme}>
        <SettingTitle>{t('settings.automata.example.title')}</SettingTitle>
        <SettingDivider />
        <Space direction="vertical" style={{ width: '100%' }}>
          <Text type="secondary">{t('settings.automata.example.description')}</Text>
          <Card>
            <pre
              style={{
                margin: 0,
                fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
                fontSize: '13px',
                lineHeight: '1.4',
                overflow: 'auto'
              }}>
              {generateCurlExample()}
            </pre>
          </Card>

          <Card
            size="small"
            title={
              <Text style={{ fontSize: '14px', fontWeight: 500 }}>{t('settings.automata.example.fields.title')}</Text>
            }
            style={{ marginTop: 16 }}>
            <Descriptions
              column={1}
              size="small"
              labelStyle={{
                width: '120px',
                fontWeight: 500
              }}
              contentStyle={{
                fontSize: '13px'
              }}>
              <Descriptions.Item label="secret">{t('settings.automata.example.comment.secret')}</Descriptions.Item>
              <Descriptions.Item label="assistantId">
                {t('settings.automata.example.comment.assistant')}
              </Descriptions.Item>
              <Descriptions.Item label="text">{t('settings.automata.example.comment.text')}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Space>
      </SettingGroup>
    </SettingContainer>
  )
}

export default AutomataSettings
