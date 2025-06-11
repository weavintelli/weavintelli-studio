import * as fs from 'fs'
import * as path from 'path'

// 配置类型定义
interface I18nConfig {
  translationsDir: string
  baseLocale: string
  placeholder: string
  encoding: BufferEncoding
}

// 翻译文件类型
type TranslationValue = string | Record<string, any>
type TranslationObject = Record<string, TranslationValue>

// 同步结果类型
interface SyncResult {
  isUpdated: boolean
  addedKeys: string[]
  removedKeys: string[]
}

// 配置
const config: I18nConfig = {
  translationsDir: path.join(__dirname, '../src/renderer/src/i18n/locales'),
  baseLocale: 'zh-CN',
  placeholder: '[to be translated]',
  encoding: 'utf-8'
}

/**
 * 安全地读取并解析 JSON 文件
 */
function readJsonFile(filePath: string): TranslationObject | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`文件不存在: ${filePath}`)
      return null
    }

    const content = fs.readFileSync(filePath, config.encoding)
    return JSON.parse(content) as TranslationObject
  } catch (error) {
    console.error(`读取或解析文件失败 ${filePath}:`, error instanceof Error ? error.message : String(error))
    return null
  }
}

/**
 * 安全地写入 JSON 文件
 */
function writeJsonFile(filePath: string, data: TranslationObject): boolean {
  try {
    const content = JSON.stringify(data, null, 2) + '\n'
    fs.writeFileSync(filePath, content, config.encoding)
    return true
  } catch (error) {
    console.error(`写入文件失败 ${filePath}:`, error instanceof Error ? error.message : String(error))
    return false
  }
}

/**
 * 检查值是否为普通对象
 */
function isPlainObject(value: unknown): value is TranslationObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 创建翻译占位符
 */
function createPlaceholder(originalValue: TranslationValue): string {
  return `${config.placeholder}:${originalValue}`
}

/**
 * 递归同步翻译对象
 * @param target 目标翻译对象
 * @param template 模板翻译对象
 * @param keyPath 当前键路径（用于日志）
 * @returns 同步结果
 */
function syncTranslationObject(
  target: TranslationObject,
  template: TranslationObject,
  keyPath: string = ''
): SyncResult {
  const result: SyncResult = {
    isUpdated: false,
    addedKeys: [],
    removedKeys: []
  }

  // 添加模板中存在但目标中缺失的键
  for (const [key, templateValue] of Object.entries(template)) {
    const currentPath = keyPath ? `${keyPath}.${key}` : key

    if (!(key in target)) {
      if (isPlainObject(templateValue)) {
        target[key] = {}
      } else {
        target[key] = createPlaceholder(templateValue)
      }
      result.addedKeys.push(currentPath)
      result.isUpdated = true
    }

    // 处理嵌套对象
    if (isPlainObject(templateValue)) {
      if (!isPlainObject(target[key])) {
        target[key] = {}
        result.isUpdated = true
      }

      const childResult = syncTranslationObject(target[key] as TranslationObject, templateValue, currentPath)

      if (childResult.isUpdated) {
        result.isUpdated = true
        result.addedKeys.push(...childResult.addedKeys)
        result.removedKeys.push(...childResult.removedKeys)
      }
    }
  }

  // 删除目标中存在但模板中不存在的键
  for (const key of Object.keys(target)) {
    if (!(key in template)) {
      const currentPath = keyPath ? `${keyPath}.${key}` : key
      delete target[key]
      result.removedKeys.push(currentPath)
      result.isUpdated = true
    }
  }

  return result
}

/**
 * 获取翻译文件列表
 */
function getTranslationFiles(): string[] {
  try {
    const baseFileName = `${config.baseLocale}.json`
    return fs.readdirSync(config.translationsDir).filter((file) => file.endsWith('.json') && file !== baseFileName)
  } catch (error) {
    console.error(`读取翻译目录失败:`, error instanceof Error ? error.message : String(error))
    return []
  }
}

/**
 * 同步单个翻译文件
 */
function syncSingleFile(fileName: string, baseTemplate: TranslationObject): boolean {
  const filePath = path.join(config.translationsDir, fileName)
  const targetTranslation = readJsonFile(filePath)

  if (!targetTranslation) {
    return false
  }

  console.log(`\n处理文件: ${fileName}`)
  const syncResult = syncTranslationObject(targetTranslation, baseTemplate)

  if (!syncResult.isUpdated) {
    console.log(`✅ ${fileName} 无需更新`)
    return true
  }

  // 输出详细的变更信息
  if (syncResult.addedKeys.length > 0) {
    console.log(`➕ 添加的键 (${syncResult.addedKeys.length}):`)
    syncResult.addedKeys.forEach((key) => console.log(`   - ${key}`))
  }

  if (syncResult.removedKeys.length > 0) {
    console.log(`➖ 删除的键 (${syncResult.removedKeys.length}):`)
    syncResult.removedKeys.forEach((key) => console.log(`   - ${key}`))
  }

  const writeSuccess = writeJsonFile(filePath, targetTranslation)
  if (writeSuccess) {
    console.log(`✅ ${fileName} 已成功更新`)
  } else {
    console.log(`❌ ${fileName} 更新失败`)
  }

  return writeSuccess
}

/**
 * 主同步函数
 */
function syncTranslations(): void {
  console.log('🚀 开始同步翻译文件...\n')

  // 读取基础模板文件
  const baseFilePath = path.join(config.translationsDir, `${config.baseLocale}.json`)
  const baseTemplate = readJsonFile(baseFilePath)

  if (!baseTemplate) {
    console.error(`❌ 无法读取基础模板文件: ${config.baseLocale}.json`)
    process.exit(1)
  }

  console.log(`📄 使用基础模板: ${config.baseLocale}.json`)

  // 获取需要同步的文件列表
  const translationFiles = getTranslationFiles()

  if (translationFiles.length === 0) {
    console.log('🔍 未找到需要同步的翻译文件')
    return
  }

  console.log(`📂 找到 ${translationFiles.length} 个翻译文件`)

  // 同步每个文件
  let successCount = 0
  let totalCount = translationFiles.length

  for (const fileName of translationFiles) {
    if (syncSingleFile(fileName, baseTemplate)) {
      successCount++
    }
  }

  // 输出总结
  console.log('\n📊 同步完成:')
  console.log(`✅ 成功: ${successCount}/${totalCount}`)

  if (successCount < totalCount) {
    console.log(`❌ 失败: ${totalCount - successCount}/${totalCount}`)
    process.exit(1)
  }
}

// 执行同步
if (require.main === module) {
  syncTranslations()
}

export { syncTranslations, config }
