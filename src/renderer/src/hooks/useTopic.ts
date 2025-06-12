import db from '@renderer/databases'
import i18n from '@renderer/i18n'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { deleteMessageFiles } from '@renderer/services/MessagesService'
import store from '@renderer/store'
import { updateTopic } from '@renderer/store/assistants'
import { loadTopicMessagesThunk } from '@renderer/store/thunk/messageThunk'
import { Assistant, Topic } from '@renderer/types'
import { findMainTextBlocks } from '@renderer/utils/messageUtils/find'
import { find, isEmpty } from 'lodash'
import { useEffect, useState } from 'react'

import { useAssistant } from './useAssistant'
import { getStoreSetting } from './useSettings'

const renamingTopics = new Set<string>()

let _activeTopic: Topic
let _setActiveTopic: (topic: Topic) => void

export function useActiveTopic(_assistant: Assistant, topic?: Topic) {
  const { assistant } = useAssistant(_assistant.id)
  const [activeTopic, setActiveTopic] = useState(topic || _activeTopic || assistant?.topics[0])

  _activeTopic = activeTopic
  _setActiveTopic = setActiveTopic

  useEffect(() => {
    if (activeTopic) {
      store.dispatch(loadTopicMessagesThunk(activeTopic.id))
      EventEmitter.emit(EVENT_NAMES.CHANGE_TOPIC, activeTopic)
    }
  }, [activeTopic])

  useEffect(() => {
    // activeTopic not in assistant.topics
    if (assistant && !find(assistant.topics, { id: activeTopic?.id })) {
      setActiveTopic(assistant.topics[0])
    }
  }, [activeTopic?.id, assistant])

  return { activeTopic, setActiveTopic }
}

export function useTopic(assistant: Assistant, topicId?: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

export function getTopic(assistant: Assistant, topicId: string) {
  return assistant?.topics.find((topic) => topic.id === topicId)
}

export async function getTopicById(topicId: string) {
  const assistants = store.getState().assistants.assistants
  const topics = assistants.map((assistant) => assistant.topics).flat()
  const topic = topics.find((topic) => topic.id === topicId)
  const messages = await TopicManager.getTopicMessages(topicId)
  return { ...topic, messages } as Topic
}

export const autoRenameTopic = async (assistant: Assistant, topicId: string) => {
  if (renamingTopics.has(topicId)) {
    return
  }

  try {
    renamingTopics.add(topicId)

    const topic = await getTopicById(topicId)
    const enableTopicNaming = getStoreSetting('enableTopicNaming')

    if (isEmpty(topic.messages)) {
      return
    }

    if (topic.isNameManuallyEdited) {
      return
    }

    if (!enableTopicNaming) {
      const message = topic.messages[0]
      const blocks = findMainTextBlocks(message)
      const topicName = blocks
        .map((block) => block.content)
        .join('\n\n')
        .substring(0, 50)
      if (topicName) {
        const data = { ...topic, name: topicName } as Topic
        _setActiveTopic(data)
        store.dispatch(updateTopic({ assistantId: assistant.id, topic: data }))
      }
      return
    }

    if (topic && topic.name === i18n.t('chat.default.topic.name') && topic.messages.length >= 2) {
      const { fetchMessagesSummary } = await import('@renderer/services/ApiService')
      const summaryText = await fetchMessagesSummary({ messages: topic.messages, assistant })
      if (summaryText) {
        const data = { ...topic, name: summaryText }
        _setActiveTopic(data)
        store.dispatch(updateTopic({ assistantId: assistant.id, topic: data }))
      }
    }
  } finally {
    renamingTopics.delete(topicId)
  }
}

// Convert class to object with functions since class only has static methods
// 只有静态方法,没必要用class，可以export {}
export const TopicManager = {
  async getTopic(id: string) {
    return await db.topics.get(id)
  },

  async getAllTopics() {
    return await db.topics.toArray()
  },

  async getTopicMessages(id: string) {
    const topic = await TopicManager.getTopic(id)
    return topic ? topic.messages : []
  },

  async removeTopic(id: string) {
    const messages = await TopicManager.getTopicMessages(id)

    for (const message of messages) {
      await deleteMessageFiles(message)
    }

    db.topics.delete(id)
  },

  async clearTopicMessages(id: string) {
    const topic = await TopicManager.getTopic(id)

    if (topic) {
      for (const message of topic?.messages ?? []) {
        await deleteMessageFiles(message)
      }

      topic.messages = []

      await db.topics.update(id, topic)
    }
  }
}
