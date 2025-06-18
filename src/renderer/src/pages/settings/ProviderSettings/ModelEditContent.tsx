import { DownOutlined, UpOutlined } from '@ant-design/icons'
import CopyIcon from '@renderer/components/Icons/CopyIcon'
import {
  isEmbeddingModel,
  isFunctionCallingModel,
  isReasoningModel,
  isVisionModel,
  isWebSearchModel
} from '@renderer/config/models'
import { Model, ModelType } from '@renderer/types'
import { getDefaultGroupName } from '@renderer/utils'
import { Button, Checkbox, Divider, Flex, Form, Input, InputNumber, message, Modal, Select } from 'antd'
import { FC, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
interface ModelEditContentProps {
  model: Model
  onUpdateModel: (model: Model) => void
  open: boolean
  onClose: () => void
}

const symbols = ['$', '¥', '€', '£']
const ModelEditContent: FC<ModelEditContentProps> = ({ model, onUpdateModel, open, onClose }) => {
  const [form] = Form.useForm()
  const { t } = useTranslation()
  const [showMoreSettings, setShowMoreSettings] = useState(false)
  const [currencySymbol, setCurrencySymbol] = useState(model.pricing?.currencySymbol || '$')
  const [isCustomCurrency, setIsCustomCurrency] = useState(!symbols.includes(model.pricing?.currencySymbol || '$'))

  const onFinish = (values: any) => {
    const finalCurrencySymbol = isCustomCurrency ? values.customCurrencySymbol : values.currencySymbol
    const updatedModel = {
      ...model,
      id: values.id || model.id,
      name: values.name || model.name,
      group: values.group || model.group,
      pricing: {
        input_per_million_tokens: Number(values.input_per_million_tokens) || 0,
        output_per_million_tokens: Number(values.output_per_million_tokens) || 0,
        currencySymbol: finalCurrencySymbol || '$'
      }
    }
    onUpdateModel(updatedModel)
    setShowMoreSettings(false)
    onClose()
  }

  const handleClose = () => {
    setShowMoreSettings(false)
    onClose()
  }

  const currencyOptions = [
    ...symbols.map((symbol) => ({ label: symbol, value: symbol })),
    { label: t('models.price.custom'), value: 'custom' }
  ]

  return (
    <Modal
      title={t('models.edit')}
      open={open}
      onCancel={handleClose}
      footer={null}
      maskClosable={false}
      transitionName="animation-move-down"
      centered
      afterOpenChange={(visible) => {
        if (visible) {
          form.getFieldInstance('id')?.focus()
        } else {
          setShowMoreSettings(false)
        }
      }}>
      <Form
        form={form}
        labelCol={{ flex: '110px' }}
        labelAlign="left"
        colon={false}
        style={{ marginTop: 15 }}
        initialValues={{
          id: model.id,
          name: model.name,
          group: model.group,
          input_per_million_tokens: model.pricing?.input_per_million_tokens ?? 0,
          output_per_million_tokens: model.pricing?.output_per_million_tokens ?? 0,
          currencySymbol: symbols.includes(model.pricing?.currencySymbol || '$')
            ? model.pricing?.currencySymbol || '$'
            : 'custom',
          customCurrencySymbol: symbols.includes(model.pricing?.currencySymbol || '$')
            ? ''
            : model.pricing?.currencySymbol || ''
        }}
        onFinish={onFinish}>
        <Form.Item
          name="id"
          label={t('settings.models.add.model_id')}
          tooltip={t('settings.models.add.model_id.tooltip')}
          rules={[{ required: true }]}>
          <Flex justify="space-between" gap={5}>
            <Input
              placeholder={t('settings.models.add.model_id.placeholder')}
              spellCheck={false}
              maxLength={200}
              disabled={true}
              value={model.id}
              onChange={(e) => {
                const value = e.target.value
                form.setFieldValue('name', value)
                form.setFieldValue('group', getDefaultGroupName(value))
              }}
            />
            <Button
              onClick={() => {
                //copy model id
                const val = form.getFieldValue('name')
                navigator.clipboard.writeText((val.id || model.id) as string)
                message.success(t('message.copied'))
              }}>
              <CopyIcon /> {t('chat.topics.copy.title')}
            </Button>
          </Flex>
        </Form.Item>
        <Form.Item
          name="name"
          label={t('settings.models.add.model_name')}
          tooltip={t('settings.models.add.model_name.tooltip')}>
          <Input placeholder={t('settings.models.add.model_name.placeholder')} spellCheck={false} />
        </Form.Item>
        <Form.Item
          name="group"
          label={t('settings.models.add.group_name')}
          tooltip={t('settings.models.add.group_name.tooltip')}>
          <Input placeholder={t('settings.models.add.group_name.placeholder')} spellCheck={false} />
        </Form.Item>
        <Form.Item style={{ marginBottom: 15, textAlign: 'center' }}>
          <Flex justify="center" align="center" style={{ position: 'relative' }}>
            <MoreSettingsRow
              onClick={() => setShowMoreSettings(!showMoreSettings)}
              style={{ position: 'absolute', right: 0 }}>
              {t('settings.moresetting')}
              <ExpandIcon>{showMoreSettings ? <UpOutlined /> : <DownOutlined />}</ExpandIcon>
            </MoreSettingsRow>
            <Button type="primary" htmlType="submit" size="middle">
              {t('common.save')}
            </Button>
          </Flex>
        </Form.Item>
        {showMoreSettings && (
          <div>
            <Divider style={{ margin: '0 0 15px 0' }} />
            <TypeTitle>{t('models.type.select')}</TypeTitle>
            {(() => {
              const defaultTypes = [
                ...(isVisionModel(model) ? ['vision'] : []),
                ...(isEmbeddingModel(model) ? ['embedding'] : []),
                ...(isReasoningModel(model) ? ['reasoning'] : []),
                ...(isFunctionCallingModel(model) ? ['function_calling'] : []),
                ...(isWebSearchModel(model) ? ['web_search'] : [])
              ] as ModelType[]

              // 合并现有选择和默认类型
              const selectedTypes = [...new Set([...(model.type || []), ...defaultTypes])]

              const showTypeConfirmModal = (type: string) => {
                window.modal.confirm({
                  title: t('settings.moresetting.warn'),
                  content: t('settings.moresetting.check.warn'),
                  okText: t('settings.moresetting.check.confirm'),
                  cancelText: t('common.cancel'),
                  okButtonProps: { danger: true },
                  cancelButtonProps: { type: 'primary' },
                  onOk: () => onUpdateModel({ ...model, type: [...selectedTypes, type] as ModelType[] }),
                  onCancel: () => {},
                  centered: true
                })
              }

              const handleTypeChange = (types: string[]) => {
                const newType = types.find((type) => !selectedTypes.includes(type as ModelType))

                if (newType) {
                  showTypeConfirmModal(newType)
                } else {
                  onUpdateModel({ ...model, type: types as ModelType[] })
                }
              }

              return (
                <Checkbox.Group
                  value={selectedTypes}
                  onChange={handleTypeChange}
                  options={[
                    {
                      label: t('models.type.vision'),
                      value: 'vision',
                      disabled: isVisionModel(model) && !selectedTypes.includes('vision')
                    },
                    {
                      label: t('models.type.websearch'),
                      value: 'web_search',
                      disabled: isWebSearchModel(model) && !selectedTypes.includes('web_search')
                    },
                    {
                      label: t('models.type.embedding'),
                      value: 'embedding',
                      disabled: isEmbeddingModel(model) && !selectedTypes.includes('embedding')
                    },
                    {
                      label: t('models.type.reasoning'),
                      value: 'reasoning',
                      disabled: isReasoningModel(model) && !selectedTypes.includes('reasoning')
                    },
                    {
                      label: t('models.type.function_calling'),
                      value: 'function_calling',
                      disabled: isFunctionCallingModel(model) && !selectedTypes.includes('function_calling')
                    }
                  ]}
                />
              )
            })()}
            <TypeTitle>{t('models.price.price')}</TypeTitle>
            <Form.Item name="currencySymbol" label={t('models.price.currency')} style={{ marginBottom: 10 }}>
              <Select
                style={{ width: '100px' }}
                options={currencyOptions}
                onChange={(value) => {
                  if (value === 'custom') {
                    setIsCustomCurrency(true)
                    setCurrencySymbol(form.getFieldValue('customCurrencySymbol') || '')
                  } else {
                    setIsCustomCurrency(false)
                    setCurrencySymbol(value)
                  }
                }}
                dropdownMatchSelectWidth={false}
              />
            </Form.Item>

            {isCustomCurrency && (
              <Form.Item
                name="customCurrencySymbol"
                label={t('models.price.custom_currency')}
                style={{ marginBottom: 10 }}
                rules={[{ required: isCustomCurrency }]}>
                <Input
                  style={{ width: '100px' }}
                  placeholder={t('models.price.custom_currency_placeholder')}
                  maxLength={5}
                  onChange={(e) => setCurrencySymbol(e.target.value)}
                />
              </Form.Item>
            )}

            <Form.Item label={t('models.price.input')} name="input_per_million_tokens">
              <InputNumber
                placeholder="0.00"
                min={0}
                step={0.01}
                precision={2}
                style={{ width: '240px' }}
                addonAfter={`${currencySymbol} / ${t('models.price.million_tokens')}`}
              />
            </Form.Item>
            <Form.Item label={t('models.price.output')} name="output_per_million_tokens">
              <InputNumber
                placeholder="0.00"
                min={0}
                step={0.01}
                precision={2}
                style={{ width: '240px' }}
                addonAfter={`${currencySymbol} / ${t('models.price.million_tokens')}`}
              />
            </Form.Item>
          </div>
        )}
      </Form>
    </Modal>
  )
}

const TypeTitle = styled.div`
  margin-top: 16px;
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
`

const ExpandIcon = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
`

const MoreSettingsRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-3);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;

  &:hover {
    background-color: var(--color-background-soft);
  }
`

export default ModelEditContent
