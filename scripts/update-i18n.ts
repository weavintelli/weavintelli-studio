import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import OpenAI from 'openai'

// 配置接口
interface LanguageConfig {
  name: string
  code: string
  model: string
}

interface TranslationTexts {
  [key: string]: string
}

interface NestedObject {
  [key: string]: any
}

// 配置接口
interface I18nConfig {
  languages: LanguageConfig[]
  paths: {
    source: string
    outputDir: string
  }
  translation: {
    maxRetries: number
    retryDelay: number
    batchSize: number
    concurrency: number
    temperature: number
  }
}

// 配置常量
const CONFIG: I18nConfig = {
  languages: [
    { name: 'French', code: 'fr-fr', model: 'qwen-plus-latest' },
    { name: 'Spanish', code: 'es-es', model: 'qwen-plus-latest' },
    { name: 'Portuguese', code: 'pt-pt', model: 'qwen-plus-latest' },
    { name: 'Greek', code: 'el-gr', model: 'qwen-plus-latest' }
  ],
  paths: {
    source: 'src/renderer/src/i18n/locales/zh-cn.json',
    outputDir: 'src/renderer/src/i18n/translate'
  },
  translation: {
    maxRetries: 3,
    retryDelay: 1000,
    batchSize: 20,
    concurrency: 2,
    temperature: 0.3
  }
}

// 日志工具
class Logger {
  static info(message: string, ...args: any[]) {
    console.log(`[INFO] ${new Date().toISOString()} ${message}`, ...args)
  }

  static warn(message: string, ...args: any[]) {
    console.warn(`[WARN] ${new Date().toISOString()} ${message}`, ...args)
  }

  static error(message: string, ...args: any[]) {
    console.error(`[ERROR] ${new Date().toISOString()} ${message}`, ...args)
  }

  static success(message: string, ...args: any[]) {
    console.log(`[SUCCESS] ${new Date().toISOString()} ${message}`, ...args)
  }
}

// 翻译服务类
class TranslationService {
  private openai: OpenAI

  constructor() {
    if (!process.env.DASHSCOPE_API_KEY) {
      throw new Error('DASHSCOPE_API_KEY environment variable is required')
    }

    this.openai = new OpenAI({
      apiKey: process.env.DASHSCOPE_API_KEY,
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/'
    })
  }

  // 构建翻译 prompt
  private buildTranslationPrompt(targetLanguage: string, texts: TranslationTexts): any[] {
    const exampleInput = {
      confirm: '确定要备份数据吗？',
      select_model: '选择模型',
      title: '文件',
      deeply_thought: '已深度思考（用时 {{seconds}} 秒）'
    }

    const exampleOutput = this.getExampleTranslation(targetLanguage)

    return [
      {
        role: 'user',
        content: `You are a professional translation assistant. Please translate the following JSON content from Chinese to ${targetLanguage}.

Rules:
1. Maintain the JSON structure exactly
2. Preserve all placeholder variables like {{variable}}
3. Keep capitalization style consistent with the source
4. Ensure natural and fluent translations
5. Do not omit any keys

Example input:
${JSON.stringify(exampleInput, null, 2)}

Example output:
${JSON.stringify(exampleOutput, null, 2)}

Now translate this content to ${targetLanguage}:
${JSON.stringify(texts, null, 2)}

Please output ONLY the translated JSON, ensuring all keys are included.`
      }
    ]
  }

  // 获取示例翻译（根据目标语言）
  private getExampleTranslation(targetLanguage: string): TranslationTexts {
    const examples: Record<string, TranslationTexts> = {
      French: {
        confirm: 'Êtes-vous sûr de vouloir sauvegarder les données ?',
        select_model: 'Sélectionner le modèle',
        title: 'Fichier',
        deeply_thought: 'Réflexion approfondie (temps écoulé {{seconds}} secondes)'
      },
      Spanish: {
        confirm: '¿Estás seguro de que quieres hacer una copia de seguridad de los datos?',
        select_model: 'Seleccionar modelo',
        title: 'Archivo',
        deeply_thought: 'Pensamiento profundo (tomó {{seconds}} segundos)'
      },
      Portuguese: {
        confirm: 'Tem certeza de que deseja fazer backup dos dados?',
        select_model: 'Selecionar modelo',
        title: 'Arquivo',
        deeply_thought: 'Pensamento profundo (levou {{seconds}} segundos)'
      },
      Greek: {
        confirm: 'Είστε σίγουροι ότι θέλετε να δημιουργήσετε αντίγραφο ασφαλείας των δεδομένων;',
        select_model: 'Επιλογή μοντέλου',
        title: 'Αρχείο',
        deeply_thought: 'Βαθιά σκέψη (χρειάστηκε {{seconds}} δευτερόλεπτα)'
      }
    }

    return examples[targetLanguage] || examples.French
  }

  // 带重试的翻译方法
  async translateWithRetry(
    texts: TranslationTexts,
    targetLanguage: string,
    model: string,
    retries: number = CONFIG.translation.maxRetries
  ): Promise<TranslationTexts> {
    try {
      const messages = this.buildTranslationPrompt(targetLanguage, texts)

      const completion = await this.openai.chat.completions.create({
        model,
        response_format: { type: 'json_object' },
        messages,
        temperature: CONFIG.translation.temperature
      })

      const content = completion.choices[0]?.message?.content
      if (!content) {
        throw new Error('Empty response from translation API')
      }

      const result = JSON.parse(content)

      // 验证翻译结果
      this.validateTranslationResult(texts, result, targetLanguage)

      return result
    } catch (error) {
      if (retries > 0) {
        Logger.warn(`Translation failed, retrying... (${retries} attempts left)`, error)
        await this.sleep(CONFIG.translation.retryDelay)
        return this.translateWithRetry(texts, targetLanguage, model, retries - 1)
      }
      throw error
    }
  }

  // 验证翻译结果
  private validateTranslationResult(
    originalTexts: TranslationTexts,
    translatedTexts: TranslationTexts,
    targetLanguage: string
  ): void {
    const missingKeys = Object.keys(originalTexts).filter(
      (key) => !translatedTexts[key] || typeof translatedTexts[key] !== 'string'
    )

    if (missingKeys.length > 0) {
      Logger.warn(`Missing translations for ${targetLanguage}:`, missingKeys)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// 文件操作工具类
class FileManager {
  static readJsonFile(filePath: string): any {
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      return JSON.parse(content)
    } catch (error) {
      Logger.error(`Failed to read file ${filePath}:`, error)
      throw error
    }
  }

  static writeJsonFile(filePath: string, data: any): void {
    try {
      // 确保目录存在
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // 创建备份
      if (fs.existsSync(filePath)) {
        const backupPath = `${filePath}.backup.${Date.now()}`
        fs.copyFileSync(filePath, backupPath)
        Logger.info(`Created backup: ${backupPath}`)
      }

      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
      Logger.success(`Updated: ${filePath}`)
    } catch (error) {
      Logger.error(`Failed to write file ${filePath}:`, error)
      throw error
    }
  }

  static ensureOutputDirectory(): void {
    if (!fs.existsSync(CONFIG.paths.outputDir)) {
      fs.mkdirSync(CONFIG.paths.outputDir, { recursive: true })
      Logger.info(`Created output directory: ${CONFIG.paths.outputDir}`)
    }
  }
}

// 主要的翻译处理类
class I18nUpdater {
  private translationService: TranslationService
  private sourceData: NestedObject

  constructor() {
    this.translationService = new TranslationService()
    this.sourceData = FileManager.readJsonFile(CONFIG.paths.source)
  }

  // 递归收集需要翻译的文本
  private collectTextsToTranslate(sourceObj: NestedObject, targetObj: NestedObject, path = ''): TranslationTexts {
    const texts: TranslationTexts = {}

    for (const key in sourceObj) {
      const currentPath = path ? `${path}.${key}` : key

      if (typeof sourceObj[key] === 'object' && sourceObj[key] !== null) {
        // 确保目标对象有对应的嵌套结构
        if (!targetObj[key] || typeof targetObj[key] !== 'object') {
          targetObj[key] = {}
        }

        const nestedTexts = this.collectTextsToTranslate(sourceObj[key], targetObj[key], currentPath)
        Object.assign(texts, nestedTexts)
      } else if (typeof sourceObj[key] === 'string') {
        // 检查是否需要翻译
        if (!targetObj[key] || typeof targetObj[key] !== 'string') {
          texts[currentPath] = sourceObj[key]
        }
      }
    }

    return texts
  }

  // 将翻译结果应用到目标对象
  private applyTranslations(targetObj: NestedObject, translations: TranslationTexts): void {
    for (const [path, translation] of Object.entries(translations)) {
      const keys = path.split('.')
      let current = targetObj

      // 导航到正确的嵌套位置
      for (let i = 0; i < keys.length - 1; i++) {
        // 如果键不存在或者不是对象（可能是字符串），则创建新对象
        if (!current[keys[i]] || typeof current[keys[i]] !== 'object' || current[keys[i]] === null) {
          current[keys[i]] = {}
        }
        current = current[keys[i]]
      }

      current[keys[keys.length - 1]] = translation
    }
  }

  // 清理多余的键值
  private cleanupExtraKeys(sourceObj: NestedObject, targetObj: NestedObject): void {
    for (const key in targetObj) {
      if (!sourceObj[key]) {
        delete targetObj[key]
        Logger.info(`Removed obsolete key: ${key}`)
      } else if (typeof sourceObj[key] === 'object' && typeof targetObj[key] === 'object') {
        this.cleanupExtraKeys(sourceObj[key], targetObj[key])
      }
    }
  }

  // 分批处理翻译
  private chunkTexts(texts: TranslationTexts, size: number): TranslationTexts[] {
    const entries = Object.entries(texts)
    const chunks: TranslationTexts[] = []

    for (let i = 0; i < entries.length; i += size) {
      const chunk = Object.fromEntries(entries.slice(i, i + size))
      chunks.push(chunk)
    }

    return chunks
  }

  // 处理单个语言的翻译
  async translateLanguage(config: LanguageConfig): Promise<void> {
    const outputPath = path.join(CONFIG.paths.outputDir, `${config.code}.json`)
    const existingData = fs.existsSync(outputPath) ? FileManager.readJsonFile(outputPath) : {}

    Logger.info(`Starting translation for ${config.name} (${config.code})`)

    try {
      // 收集需要翻译的文本
      const textsToTranslate = this.collectTextsToTranslate(this.sourceData, existingData)

      if (Object.keys(textsToTranslate).length === 0) {
        Logger.info(`No new translations needed for ${config.name}`)
        return
      }

      Logger.info(`Found ${Object.keys(textsToTranslate).length} texts to translate for ${config.name}`)

      // 分批处理翻译
      const textChunks = this.chunkTexts(textsToTranslate, CONFIG.translation.batchSize)
      const allTranslations: TranslationTexts = {}

      for (let i = 0; i < textChunks.length; i++) {
        const chunk = textChunks[i]
        Logger.info(`Translating batch ${i + 1}/${textChunks.length} for ${config.name}`)

        const translations = await this.translationService.translateWithRetry(chunk, config.name, config.model)

        Object.assign(allTranslations, translations)
      }

      // 应用翻译结果
      this.applyTranslations(existingData, allTranslations)

      // 清理多余的键值
      this.cleanupExtraKeys(this.sourceData, existingData)

      // 保存文件
      FileManager.writeJsonFile(outputPath, existingData)

      Logger.success(`Completed translation for ${config.name}`)
    } catch (error) {
      Logger.error(`Failed to translate ${config.name}:`, error)
      throw error
    }
  }

  // 并行处理所有语言翻译
  async updateAllLanguages(): Promise<void> {
    FileManager.ensureOutputDirectory()

    Logger.info('Starting i18n translation update')
    Logger.info(`Processing ${CONFIG.languages.length} languages`)

    try {
      // 并行处理所有语言（但要控制并发数避免API限制）
      const concurrency = CONFIG.translation.concurrency
      const chunks: LanguageConfig[][] = []

      for (let i = 0; i < CONFIG.languages.length; i += concurrency) {
        chunks.push(CONFIG.languages.slice(i, i + concurrency))
      }

      for (const chunk of chunks) {
        await Promise.all(chunk.map((config) => this.translateLanguage(config)))
      }

      Logger.success('All translations completed successfully!')
    } catch (error) {
      Logger.error('Translation process failed:', error)
      process.exit(1)
    }
  }
}

// 主执行函数
async function main() {
  try {
    // 验证源文件存在
    if (!fs.existsSync(CONFIG.paths.source)) {
      throw new Error(`Source file not found: ${CONFIG.paths.source}`)
    }

    const updater = new I18nUpdater()
    await updater.updateAllLanguages()
  } catch (error) {
    Logger.error('Failed to update i18n:', error)
    process.exit(1)
  }
}

// 执行脚本
if (require.main === module) {
  main()
}

export { I18nUpdater, TranslationService, FileManager }
