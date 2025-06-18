import { isMac, isWindows } from '@renderer/config/constant'
import Logger from '@renderer/config/logger'
import type { SendMessageShortcut } from '@renderer/store/settings'
import { FileType } from '@renderer/types'

export const getFilesFromDropEvent = async (e: React.DragEvent<HTMLDivElement>): Promise<FileType[]> => {
  if (e.dataTransfer.files.length > 0) {
    // 使用新的API获取文件路径
    const filePromises = [...e.dataTransfer.files].map(async (file) => {
      try {
        // 使用新的webUtils.getPathForFile API获取文件路径
        const filePath = window.api.file.getPathForFile(file)
        if (filePath) {
          return window.api.file.get(filePath)
        }
        return null
      } catch (error) {
        Logger.error('[src/renderer/src/utils/input.ts] getFilesFromDropEvent - getPathForFile error:', error)
        return null
      }
    })

    const results = await Promise.allSettled(filePromises)
    const list: FileType[] = []
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        list.push(result.value)
      } else if (result.status === 'rejected') {
        Logger.error('[src/renderer/src/utils/input.ts] getFilesFromDropEvent:', result.reason)
      }
    }
    return list
  } else {
    return new Promise((resolve) => {
      let existCodefilesFormat = false
      for (const item of e.dataTransfer.items) {
        const { type } = item
        if (type === 'codefiles') {
          item.getAsString(async (filePathListString) => {
            const filePathList: string[] = JSON.parse(filePathListString)
            const filePathListPromises = filePathList.map((filePath) => window.api.file.get(filePath))
            resolve(
              await Promise.allSettled(filePathListPromises).then((results) =>
                results
                  .filter((result) => result.status === 'fulfilled')
                  .filter((result) => result.value !== null)
                  .map((result) => result.value!)
              )
            )
          })

          existCodefilesFormat = true
          break
        }
      }

      if (!existCodefilesFormat) {
        resolve([])
      }
    })
  }
}

// convert send message shortcut to human readable label
export const getSendMessageShortcutLabel = (shortcut: SendMessageShortcut) => {
  switch (shortcut) {
    case 'Enter':
      return 'Enter'
    case 'Ctrl+Enter':
      return 'Ctrl + Enter'
    case 'Alt+Enter':
      return `${isMac ? '⌥' : 'Alt'} + Enter`
    case 'Command+Enter':
      return `${isMac ? '⌘' : isWindows ? 'Win' : 'Super'} + Enter`
    case 'Shift+Enter':
      return 'Shift + Enter'
    default:
      return shortcut
  }
}

// check if the send message key is pressed in textarea
export const isSendMessageKeyPressed = (
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  shortcut: SendMessageShortcut
) => {
  let isSendMessageKeyPressed = false
  switch (shortcut) {
    case 'Enter':
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) isSendMessageKeyPressed = true
      break
    case 'Ctrl+Enter':
      if (event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey) isSendMessageKeyPressed = true
      break
    case 'Command+Enter':
      if (event.metaKey && !event.shiftKey && !event.ctrlKey && !event.altKey) isSendMessageKeyPressed = true
      break
    case 'Alt+Enter':
      if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) isSendMessageKeyPressed = true
      break
    case 'Shift+Enter':
      if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) isSendMessageKeyPressed = true
      break
  }
  return isSendMessageKeyPressed
}
