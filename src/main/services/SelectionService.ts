import { SELECTION_FINETUNED_LIST, SELECTION_PREDEFINED_BLACKLIST } from '@main/configs/SelectionConfig'
import { isDev, isWin } from '@main/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { BrowserWindow, ipcMain, screen } from 'electron'
import Logger from 'electron-log'
import { join } from 'path'
import type {
  KeyboardEventData,
  MouseEventData,
  SelectionHookConstructor,
  SelectionHookInstance,
  TextSelectionData
} from 'selection-hook'

import type { ActionItem } from '../../renderer/src/types/selectionTypes'
import { ConfigKeys, configManager } from './ConfigManager'
import storeSyncService from './StoreSyncService'

let SelectionHook: SelectionHookConstructor | null = null
try {
  if (isWin) {
    SelectionHook = require('selection-hook')
  }
} catch (error) {
  Logger.error('Failed to load selection-hook:', error)
}

// Type definitions
type Point = { x: number; y: number }
type RelativeOrientation =
  | 'topLeft'
  | 'topRight'
  | 'topMiddle'
  | 'bottomLeft'
  | 'bottomRight'
  | 'bottomMiddle'
  | 'middleLeft'
  | 'middleRight'
  | 'center'

enum TriggerMode {
  Selected = 'selected',
  Ctrlkey = 'ctrlkey'
}

/** SelectionService is a singleton class that manages the selection hook and the toolbar window
 *
 * Features:
 * - Text selection detection and processing
 * - Floating toolbar management
 * - Action window handling
 * - Multiple trigger modes (selection/alt-key)
 * - Screen boundary-aware positioning
 *
 * Usage:
 *   import selectionService from '/src/main/services/SelectionService'
 *   selectionService?.start()
 */
export class SelectionService {
  private static instance: SelectionService | null = null
  private selectionHook: SelectionHookInstance | null = null

  private static isIpcHandlerRegistered = false

  private initStatus: boolean = false
  private started: boolean = false

  private triggerMode = TriggerMode.Selected
  private isFollowToolbar = true
  private isRemeberWinSize = false
  private filterMode = 'default'
  private filterList: string[] = []

  private toolbarWindow: BrowserWindow | null = null
  private actionWindows = new Set<BrowserWindow>()
  private preloadedActionWindows: BrowserWindow[] = []
  private readonly PRELOAD_ACTION_WINDOW_COUNT = 1

  private isHideByMouseKeyListenerActive: boolean = false
  private isCtrlkeyListenerActive: boolean = false
  /**
   * Ctrlkey action states:
   * 0 - Ready to monitor ctrlkey action
   * >0 - Currently monitoring ctrlkey action
   * -1 - Ctrlkey action triggered, no need to process again
   */
  private lastCtrlkeyDownTime: number = 0

  private zoomFactor: number = 1

  private TOOLBAR_WIDTH = 350
  private TOOLBAR_HEIGHT = 43

  private readonly ACTION_WINDOW_WIDTH = 500
  private readonly ACTION_WINDOW_HEIGHT = 400

  private lastActionWindowSize: { width: number; height: number } = {
    width: this.ACTION_WINDOW_WIDTH,
    height: this.ACTION_WINDOW_HEIGHT
  }

  private constructor() {
    try {
      if (!SelectionHook) {
        throw new Error('module selection-hook not exists')
      }

      this.selectionHook = new SelectionHook()
      if (this.selectionHook) {
        this.initZoomFactor()

        this.initStatus = true
      }
    } catch (error) {
      this.logError('Failed to initialize SelectionService:', error as Error)
    }
  }

  public static getInstance(): SelectionService | null {
    if (!isWin) return null

    if (!SelectionService.instance) {
      SelectionService.instance = new SelectionService()
    }

    if (SelectionService.instance.initStatus) {
      return SelectionService.instance
    }
    return null
  }

  public getSelectionHook(): SelectionHookInstance | null {
    return this.selectionHook
  }

  /**
   * Initialize zoom factor from config and subscribe to changes
   * Ensures UI elements scale properly with system DPI settings
   */
  private initZoomFactor() {
    const zoomFactor = configManager.getZoomFactor()
    if (zoomFactor) {
      this.setZoomFactor(zoomFactor)
    }

    configManager.subscribe('ZoomFactor', this.setZoomFactor)
  }

  public setZoomFactor = (zoomFactor: number) => {
    this.zoomFactor = zoomFactor
  }

  private initConfig() {
    this.triggerMode = configManager.getSelectionAssistantTriggerMode() as TriggerMode
    this.isFollowToolbar = configManager.getSelectionAssistantFollowToolbar()
    this.isRemeberWinSize = configManager.getSelectionAssistantRemeberWinSize()
    this.filterMode = configManager.getSelectionAssistantFilterMode()
    this.filterList = configManager.getSelectionAssistantFilterList()

    this.setHookGlobalFilterMode(this.filterMode, this.filterList)
    this.setHookFineTunedList()

    configManager.subscribe(ConfigKeys.SelectionAssistantTriggerMode, (triggerMode: TriggerMode) => {
      const oldTriggerMode = this.triggerMode

      this.triggerMode = triggerMode
      this.processTriggerMode()

      //trigger mode changed, need to update the filter list
      if (oldTriggerMode !== triggerMode) {
        this.setHookGlobalFilterMode(this.filterMode, this.filterList)
      }
    })

    configManager.subscribe(ConfigKeys.SelectionAssistantFollowToolbar, (isFollowToolbar: boolean) => {
      this.isFollowToolbar = isFollowToolbar
    })

    configManager.subscribe(ConfigKeys.SelectionAssistantRemeberWinSize, (isRemeberWinSize: boolean) => {
      this.isRemeberWinSize = isRemeberWinSize
      //when off, reset the last action window size to default
      if (!this.isRemeberWinSize) {
        this.lastActionWindowSize = {
          width: this.ACTION_WINDOW_WIDTH,
          height: this.ACTION_WINDOW_HEIGHT
        }
      }
    })

    configManager.subscribe(ConfigKeys.SelectionAssistantFilterMode, (filterMode: string) => {
      this.filterMode = filterMode
      this.setHookGlobalFilterMode(this.filterMode, this.filterList)
    })

    configManager.subscribe(ConfigKeys.SelectionAssistantFilterList, (filterList: string[]) => {
      this.filterList = filterList
      this.setHookGlobalFilterMode(this.filterMode, this.filterList)
    })
  }

  /**
   * Set the global filter mode for the selection-hook
   * @param mode - The mode to set, either 'default', 'whitelist', or 'blacklist'
   * @param list - An array of strings representing the list of items to include or exclude
   */
  private setHookGlobalFilterMode(mode: string, list: string[]) {
    if (!this.selectionHook) return

    const modeMap = {
      default: SelectionHook!.FilterMode.DEFAULT,
      whitelist: SelectionHook!.FilterMode.INCLUDE_LIST,
      blacklist: SelectionHook!.FilterMode.EXCLUDE_LIST
    }

    let combinedList: string[] = list
    let combinedMode = mode

    //only the selected mode need to combine the predefined blacklist with the user-defined blacklist
    if (this.triggerMode === TriggerMode.Selected) {
      switch (mode) {
        case 'blacklist':
          //combine the predefined blacklist with the user-defined blacklist
          combinedList = [...new Set([...list, ...SELECTION_PREDEFINED_BLACKLIST.WINDOWS])]
          break
        case 'whitelist':
          combinedList = [...list]
          break
        case 'default':
        default:
          //use the predefined blacklist as the default filter list
          combinedList = [...SELECTION_PREDEFINED_BLACKLIST.WINDOWS]
          combinedMode = 'blacklist'
          break
      }
    }

    if (!this.selectionHook.setGlobalFilterMode(modeMap[combinedMode], combinedList)) {
      this.logError(new Error('Failed to set selection-hook global filter mode'))
    }
  }

  private setHookFineTunedList() {
    if (!this.selectionHook) return

    this.selectionHook.setFineTunedList(
      SelectionHook!.FineTunedListType.EXCLUDE_CLIPBOARD_CURSOR_DETECT,
      SELECTION_FINETUNED_LIST.EXCLUDE_CLIPBOARD_CURSOR_DETECT.WINDOWS
    )

    this.selectionHook.setFineTunedList(
      SelectionHook!.FineTunedListType.INCLUDE_CLIPBOARD_DELAY_READ,
      SELECTION_FINETUNED_LIST.INCLUDE_CLIPBOARD_DELAY_READ.WINDOWS
    )
  }

  /**
   * Start the selection service and initialize required windows
   * @returns {boolean} Success status of service start
   */
  public start(): boolean {
    if (!this.selectionHook || this.started) {
      this.logError(new Error('SelectionService start(): instance is null or already started'))
      return false
    }

    try {
      //make sure the toolbar window is ready
      this.createToolbarWindow()
      // Initialize preloaded windows
      this.initPreloadedActionWindows()
      // Handle errors
      this.selectionHook.on('error', (error: { message: string }) => {
        this.logError('Error in SelectionHook:', error as Error)
      })
      // Handle text selection events
      this.selectionHook.on('text-selection', this.processTextSelection)

      // Start the hook
      if (this.selectionHook.start({ debug: isDev })) {
        //init basic configs
        this.initConfig()

        //init trigger mode configs
        this.processTriggerMode()

        this.started = true
        this.logInfo('SelectionService Started')
        return true
      }

      this.logError(new Error('Failed to start text selection hook.'))
      return false
    } catch (error) {
      this.logError('Failed to set up text selection hook:', error as Error)
      return false
    }
  }

  /**
   * Stop the selection service and cleanup resources
   * Called when user disables selection assistant
   * @returns {boolean} Success status of service stop
   */
  public stop(): boolean {
    if (!this.selectionHook) return false

    this.selectionHook.stop()
    this.selectionHook.cleanup() //already remove all listeners

    //reset the listener states
    this.isCtrlkeyListenerActive = false
    this.isHideByMouseKeyListenerActive = false

    if (this.toolbarWindow) {
      this.toolbarWindow.close()
      this.toolbarWindow = null
    }
    this.started = false
    this.logInfo('SelectionService Stopped')
    return true
  }

  /**
   * Completely quit the selection service
   * Called when the app is closing
   */
  public quit(): void {
    if (!this.selectionHook) return

    this.stop()

    this.selectionHook = null
    this.initStatus = false
    SelectionService.instance = null
    this.logInfo('SelectionService Quitted')
  }

  /**
   * Toggle the enabled state of the selection service
   * Will sync the new enabled store to all renderer windows
   */
  public toggleEnabled(enabled: boolean | undefined = undefined) {
    if (!this.selectionHook) return

    const newEnabled = enabled === undefined ? !configManager.getSelectionAssistantEnabled() : enabled

    configManager.setSelectionAssistantEnabled(newEnabled)

    //sync the new enabled state to all renderer windows
    storeSyncService.syncToRenderer('selectionStore/setSelectionEnabled', newEnabled)
  }
  /**
   * Create and configure the toolbar window
   * Sets up window properties, event handlers, and loads the toolbar UI
   * @param readyCallback Optional callback when window is ready to show
   */
  private createToolbarWindow(readyCallback?: () => void) {
    if (this.isToolbarAlive()) return

    const { toolbarWidth, toolbarHeight } = this.getToolbarRealSize()

    this.toolbarWindow = new BrowserWindow({
      width: toolbarWidth,
      height: toolbarHeight,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      movable: true,
      focusable: false,
      hasShadow: false,
      thickFrame: false,
      roundedCorners: true,
      backgroundMaterial: 'none',
      type: 'toolbar',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        devTools: isDev ? true : false
      }
    })

    // Hide when losing focus
    this.toolbarWindow.on('blur', () => {
      this.hideToolbar()
    })

    // Clean up when closed
    this.toolbarWindow.on('closed', () => {
      this.toolbarWindow = null
    })

    // Add show/hide event listeners
    this.toolbarWindow.on('show', () => {
      this.toolbarWindow?.webContents.send(IpcChannel.Selection_ToolbarVisibilityChange, true)
    })

    this.toolbarWindow.on('hide', () => {
      this.toolbarWindow?.webContents.send(IpcChannel.Selection_ToolbarVisibilityChange, false)
    })

    /** uncomment to open dev tools in dev mode */
    // if (isDev) {
    //   this.toolbarWindow.once('ready-to-show', () => {
    //     this.toolbarWindow!.webContents.openDevTools({ mode: 'detach' })
    //   })
    // }

    if (readyCallback) {
      this.toolbarWindow.once('ready-to-show', readyCallback)
    }

    /** get ready to load the toolbar window */

    if (isDev && process.env['ELECTRON_RENDERER_URL']) {
      this.toolbarWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/selectionToolbar.html')
    } else {
      this.toolbarWindow.loadFile(join(__dirname, '../renderer/selectionToolbar.html'))
    }
  }

  /**
   * Show toolbar at specified position with given orientation
   * @param point Reference point for positioning, logical coordinates
   * @param orientation Preferred position relative to reference point
   */
  private showToolbarAtPosition(point: Point, orientation: RelativeOrientation) {
    if (!this.isToolbarAlive()) {
      this.createToolbarWindow(() => {
        this.showToolbarAtPosition(point, orientation)
      })
      return
    }

    const { x: posX, y: posY } = this.calculateToolbarPosition(point, orientation)

    const { toolbarWidth, toolbarHeight } = this.getToolbarRealSize()
    this.toolbarWindow!.setPosition(posX, posY, false)
    // Prevent window resize
    this.toolbarWindow!.setBounds({
      width: toolbarWidth,
      height: toolbarHeight,
      x: posX,
      y: posY
    })
    this.toolbarWindow!.show()
    this.toolbarWindow!.setOpacity(1)
    this.startHideByMouseKeyListener()
  }

  /**
   * Hide the toolbar window and cleanup listeners
   */
  public hideToolbar(): void {
    if (!this.isToolbarAlive()) return

    this.toolbarWindow!.setOpacity(0)
    this.toolbarWindow!.hide()

    this.stopHideByMouseKeyListener()
  }

  /**
   * Check if toolbar window exists and is not destroyed
   * @returns {boolean} Toolbar window status
   */
  private isToolbarAlive() {
    return this.toolbarWindow && !this.toolbarWindow.isDestroyed()
  }

  /**
   * Update toolbar size based on renderer feedback
   * Only updates width if it has changed
   * @param width New toolbar width
   * @param height New toolbar height
   */
  public determineToolbarSize(width: number, height: number) {
    const toolbarWidth = Math.ceil(width)

    // only update toolbar width if it's changed
    if (toolbarWidth > 0 && toolbarWidth !== this.TOOLBAR_WIDTH && height > 0) {
      this.TOOLBAR_WIDTH = toolbarWidth
    }
  }

  /**
   * Get actual toolbar dimensions accounting for zoom factor
   * @returns Object containing toolbar width and height
   */
  private getToolbarRealSize() {
    return {
      toolbarWidth: this.TOOLBAR_WIDTH * this.zoomFactor,
      toolbarHeight: this.TOOLBAR_HEIGHT * this.zoomFactor
    }
  }

  /**
   * Calculate optimal toolbar position based on selection context
   * Ensures toolbar stays within screen boundaries and follows selection direction
   * @param point Reference point for positioning, must be INTEGER
   * @param orientation Preferred position relative to reference point
   * @returns Calculated screen coordinates for toolbar, INTEGER
   */
  private calculateToolbarPosition(point: Point, orientation: RelativeOrientation): Point {
    // Calculate initial position based on the specified anchor
    let posX: number, posY: number

    const { toolbarWidth, toolbarHeight } = this.getToolbarRealSize()

    switch (orientation) {
      case 'topLeft':
        posX = point.x - toolbarWidth
        posY = point.y - toolbarHeight
        break
      case 'topRight':
        posX = point.x
        posY = point.y - toolbarHeight
        break
      case 'topMiddle':
        posX = point.x - toolbarWidth / 2
        posY = point.y - toolbarHeight
        break
      case 'bottomLeft':
        posX = point.x - toolbarWidth
        posY = point.y
        break
      case 'bottomRight':
        posX = point.x
        posY = point.y
        break
      case 'bottomMiddle':
        posX = point.x - toolbarWidth / 2
        posY = point.y
        break
      case 'middleLeft':
        posX = point.x - toolbarWidth
        posY = point.y - toolbarHeight / 2
        break
      case 'middleRight':
        posX = point.x
        posY = point.y - toolbarHeight / 2
        break
      case 'center':
        posX = point.x - toolbarWidth / 2
        posY = point.y - toolbarHeight / 2
        break
      default:
        // Default to 'topMiddle' if invalid position
        posX = point.x - toolbarWidth / 2
        posY = point.y - toolbarHeight / 2
    }

    //use original point to get the display
    const display = screen.getDisplayNearestPoint({ x: point.x, y: point.y })

    // Ensure toolbar stays within screen boundaries
    posX = Math.round(
      Math.max(display.workArea.x, Math.min(posX, display.workArea.x + display.workArea.width - toolbarWidth))
    )
    posY = Math.round(
      Math.max(display.workArea.y, Math.min(posY, display.workArea.y + display.workArea.height - toolbarHeight))
    )

    return { x: posX, y: posY }
  }

  private isSamePoint(point1: Point, point2: Point): boolean {
    return point1.x === point2.x && point1.y === point2.y
  }

  private isSameLineWithRectPoint(startTop: Point, startBottom: Point, endTop: Point, endBottom: Point): boolean {
    return startTop.y === endTop.y && startBottom.y === endBottom.y
  }

  /**
   * Determine if the text selection should be processed by filter mode&list
   * @param selectionData Text selection information and coordinates
   * @returns {boolean} True if the selection should be processed, false otherwise
   */
  private shouldProcessTextSelection(selectionData: TextSelectionData): boolean {
    if (selectionData.programName === '' || this.filterMode === 'default') {
      return true
    }

    const programName = selectionData.programName.toLowerCase()
    //items in filterList are already in lower case
    const isFound = this.filterList.some((item) => programName.includes(item))

    switch (this.filterMode) {
      case 'whitelist':
        return isFound
      case 'blacklist':
        return !isFound
    }

    return false
  }

  /**
   * Process text selection data and show toolbar
   * Handles different selection scenarios:
   * - Single click (cursor position)
   * - Mouse selection (single/double line)
   * - Keyboard selection (full/detailed)
   * @param selectionData Text selection information and coordinates
   */
  private processTextSelection = (selectionData: TextSelectionData) => {
    // Skip if no text or toolbar already visible
    if (!selectionData.text || (this.isToolbarAlive() && this.toolbarWindow!.isVisible())) {
      return
    }

    if (!this.shouldProcessTextSelection(selectionData)) {
      return
    }

    // Determine reference point and position for toolbar
    let refPoint: { x: number; y: number } = { x: 0, y: 0 }
    let isLogical = false
    let refOrientation: RelativeOrientation = 'bottomRight'

    switch (selectionData.posLevel) {
      case SelectionHook?.PositionLevel.NONE:
        {
          const cursorPoint = screen.getCursorScreenPoint()
          refPoint = { x: cursorPoint.x, y: cursorPoint.y }
          refOrientation = 'bottomMiddle'
          isLogical = true
        }
        break
      case SelectionHook?.PositionLevel.MOUSE_SINGLE:
        {
          refOrientation = 'bottomMiddle'
          refPoint = { x: selectionData.mousePosEnd.x, y: selectionData.mousePosEnd.y + 16 }
        }
        break
      case SelectionHook?.PositionLevel.MOUSE_DUAL:
        {
          const yDistance = selectionData.mousePosEnd.y - selectionData.mousePosStart.y
          const xDistance = selectionData.mousePosEnd.x - selectionData.mousePosStart.x

          // not in the same line
          if (Math.abs(yDistance) > 14) {
            if (yDistance > 0) {
              refOrientation = 'bottomLeft'
              refPoint = {
                x: selectionData.mousePosEnd.x,
                y: selectionData.mousePosEnd.y + 16
              }
            } else {
              refOrientation = 'topRight'
              refPoint = {
                x: selectionData.mousePosEnd.x,
                y: selectionData.mousePosEnd.y - 16
              }
            }
          } else {
            // in the same line
            if (xDistance > 0) {
              refOrientation = 'bottomLeft'
              refPoint = {
                x: selectionData.mousePosEnd.x,
                y: Math.max(selectionData.mousePosEnd.y, selectionData.mousePosStart.y) + 16
              }
            } else {
              refOrientation = 'bottomRight'
              refPoint = {
                x: selectionData.mousePosEnd.x,
                y: Math.min(selectionData.mousePosEnd.y, selectionData.mousePosStart.y) + 16
              }
            }
          }
        }
        break
      case SelectionHook?.PositionLevel.SEL_FULL:
      case SelectionHook?.PositionLevel.SEL_DETAILED:
        {
          //some case may not have mouse position, so use the endBottom point as reference
          const isNoMouse =
            selectionData.mousePosStart.x === 0 &&
            selectionData.mousePosStart.y === 0 &&
            selectionData.mousePosEnd.x === 0 &&
            selectionData.mousePosEnd.y === 0

          if (isNoMouse) {
            refOrientation = 'bottomLeft'
            refPoint = { x: selectionData.endBottom.x, y: selectionData.endBottom.y + 4 }
            break
          }

          const isDoubleClick = this.isSamePoint(selectionData.mousePosStart, selectionData.mousePosEnd)

          const isSameLine = this.isSameLineWithRectPoint(
            selectionData.startTop,
            selectionData.startBottom,
            selectionData.endTop,
            selectionData.endBottom
          )

          // Note: shift key + mouse click == DoubleClick

          //double click to select a word
          if (isDoubleClick && isSameLine) {
            refOrientation = 'bottomMiddle'
            refPoint = { x: selectionData.mousePosEnd.x, y: selectionData.endBottom.y + 4 }
            break
          }

          // below: isDoubleClick || isSameLine
          if (isSameLine) {
            const direction = selectionData.mousePosEnd.x - selectionData.mousePosStart.x

            if (direction > 0) {
              refOrientation = 'bottomLeft'
              refPoint = { x: selectionData.endBottom.x, y: selectionData.endBottom.y + 4 }
            } else {
              refOrientation = 'bottomRight'
              refPoint = { x: selectionData.startBottom.x, y: selectionData.startBottom.y + 4 }
            }
            break
          }

          // below: !isDoubleClick && !isSameLine
          const direction = selectionData.mousePosEnd.y - selectionData.mousePosStart.y

          if (direction > 0) {
            refOrientation = 'bottomLeft'
            refPoint = { x: selectionData.endBottom.x, y: selectionData.endBottom.y + 4 }
          } else {
            refOrientation = 'topRight'
            refPoint = { x: selectionData.startTop.x, y: selectionData.startTop.y - 4 }
          }
        }
        break
    }

    if (!isLogical) {
      //screenToDipPoint can be float, so we need to round it
      refPoint = screen.screenToDipPoint(refPoint)
      refPoint = { x: Math.round(refPoint.x), y: Math.round(refPoint.y) }
    }

    this.showToolbarAtPosition(refPoint, refOrientation)
    this.toolbarWindow?.webContents.send(IpcChannel.Selection_TextSelected, selectionData)
  }

  /**
   * Global Mouse Event Handling
   */

  // Start monitoring global mouse clicks
  private startHideByMouseKeyListener() {
    try {
      // Register event handlers
      this.selectionHook!.on('mouse-down', this.handleMouseDownHide)
      this.selectionHook!.on('mouse-wheel', this.handleMouseWheelHide)
      this.selectionHook!.on('key-down', this.handleKeyDownHide)
      this.isHideByMouseKeyListenerActive = true
    } catch (error) {
      this.logError('Failed to start global mouse event listener:', error as Error)
    }
  }

  // Stop monitoring global mouse clicks
  private stopHideByMouseKeyListener() {
    if (!this.isHideByMouseKeyListenerActive) return

    try {
      this.selectionHook!.off('mouse-down', this.handleMouseDownHide)
      this.selectionHook!.off('mouse-wheel', this.handleMouseWheelHide)
      this.selectionHook!.off('key-down', this.handleKeyDownHide)
      this.isHideByMouseKeyListenerActive = false
    } catch (error) {
      this.logError('Failed to stop global mouse event listener:', error as Error)
    }
  }

  /**
   * Handle mouse wheel events to hide toolbar
   * Hides toolbar when user scrolls
   * @param data Mouse wheel event data
   */
  private handleMouseWheelHide = () => {
    this.hideToolbar()
  }

  /**
   * Handle mouse down events to hide toolbar
   * Hides toolbar when clicking outside of it
   * @param data Mouse event data
   */
  private handleMouseDownHide = (data: MouseEventData) => {
    if (!this.isToolbarAlive()) {
      return
    }

    //data point is physical coordinates, convert to logical coordinates
    const mousePoint = screen.screenToDipPoint({ x: data.x, y: data.y })

    const bounds = this.toolbarWindow!.getBounds()

    // Check if click is outside toolbar
    const isInsideToolbar =
      mousePoint.x >= bounds.x &&
      mousePoint.x <= bounds.x + bounds.width &&
      mousePoint.y >= bounds.y &&
      mousePoint.y <= bounds.y + bounds.height

    if (!isInsideToolbar) {
      this.hideToolbar()
    }
  }

  /**
   * Handle key down events to hide toolbar
   * Hides toolbar on any key press except alt key in ctrlkey mode
   * @param data Keyboard event data
   */
  private handleKeyDownHide = (data: KeyboardEventData) => {
    //dont hide toolbar when ctrlkey is pressed
    if (this.triggerMode === TriggerMode.Ctrlkey && this.isCtrlkey(data.vkCode)) {
      return
    }
    //dont hide toolbar when shiftkey or altkey is pressed, because it's used for selection
    if (this.isShiftkey(data.vkCode) || this.isAltkey(data.vkCode)) {
      return
    }

    this.hideToolbar()
  }

  /**
   * Handle key down events in ctrlkey trigger mode
   * Processes alt key presses to trigger selection toolbar
   * @param data Keyboard event data
   */
  private handleKeyDownCtrlkeyMode = (data: KeyboardEventData) => {
    if (!this.isCtrlkey(data.vkCode)) {
      // reset the lastCtrlkeyDownTime if any other key is pressed
      if (this.lastCtrlkeyDownTime > 0) {
        this.lastCtrlkeyDownTime = -1
      }
      return
    }

    if (this.lastCtrlkeyDownTime === -1) {
      return
    }

    //ctrlkey pressed
    if (this.lastCtrlkeyDownTime === 0) {
      this.lastCtrlkeyDownTime = Date.now()
      //add the mouse-wheel&mouse-down listener, detect if user is zooming in/out or multi-selecting
      this.selectionHook!.on('mouse-wheel', this.handleMouseWheelCtrlkeyMode)
      this.selectionHook!.on('mouse-down', this.handleMouseDownCtrlkeyMode)
      return
    }

    if (Date.now() - this.lastCtrlkeyDownTime < 350) {
      return
    }

    this.lastCtrlkeyDownTime = -1

    const selectionData = this.selectionHook!.getCurrentSelection()

    if (selectionData) {
      this.processTextSelection(selectionData)
    }
  }

  /**
   * Handle key up events in ctrlkey trigger mode
   * Resets alt key state when key is released
   * @param data Keyboard event data
   */
  private handleKeyUpCtrlkeyMode = (data: KeyboardEventData) => {
    if (!this.isCtrlkey(data.vkCode)) return
    //remove the mouse-wheel&mouse-down listener
    this.selectionHook!.off('mouse-wheel', this.handleMouseWheelCtrlkeyMode)
    this.selectionHook!.off('mouse-down', this.handleMouseDownCtrlkeyMode)
    this.lastCtrlkeyDownTime = 0
  }

  /**
   * Handle mouse wheel events in ctrlkey trigger mode
   * ignore CtrlKey pressing when mouse wheel is used
   * because user is zooming in/out
   */
  private handleMouseWheelCtrlkeyMode = () => {
    this.lastCtrlkeyDownTime = -1
  }

  /**
   * Handle mouse down events in ctrlkey trigger mode
   * ignore CtrlKey pressing when mouse down is used
   * because user is multi-selecting
   */
  private handleMouseDownCtrlkeyMode = () => {
    this.lastCtrlkeyDownTime = -1
  }

  //check if the key is ctrl key
  private isCtrlkey(vkCode: number) {
    return vkCode === 162 || vkCode === 163
  }

  //check if the key is shift key
  private isShiftkey(vkCode: number) {
    return vkCode === 160 || vkCode === 161
  }

  //check if the key is alt key
  private isAltkey(vkCode: number) {
    return vkCode === 164 || vkCode === 165
  }

  /**
   * Create a preloaded action window for quick response
   * Action windows handle specific operations on selected text
   * @returns Configured BrowserWindow instance
   */
  private createPreloadedActionWindow(): BrowserWindow {
    const preloadedActionWindow = new BrowserWindow({
      width: this.isRemeberWinSize ? this.lastActionWindowSize.width : this.ACTION_WINDOW_WIDTH,
      height: this.isRemeberWinSize ? this.lastActionWindowSize.height : this.ACTION_WINDOW_HEIGHT,
      minWidth: 300,
      minHeight: 200,
      frame: false,
      transparent: true,
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      hasShadow: false,
      thickFrame: false,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: true
      }
    })

    // Load the base URL without action data
    if (isDev && process.env['ELECTRON_RENDERER_URL']) {
      preloadedActionWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/selectionAction.html')
    } else {
      preloadedActionWindow.loadFile(join(__dirname, '../renderer/selectionAction.html'))
    }

    return preloadedActionWindow
  }

  /**
   * Initialize preloaded action windows
   * Creates a pool of windows at startup for faster response
   */
  private async initPreloadedActionWindows() {
    try {
      // Create initial pool of preloaded windows
      for (let i = 0; i < this.PRELOAD_ACTION_WINDOW_COUNT; i++) {
        await this.pushNewActionWindow()
      }
    } catch (error) {
      this.logError('Failed to initialize preloaded windows:', error as Error)
    }
  }

  /**
   * Preload a new action window asynchronously
   * This method is called after popping a window to ensure we always have windows ready
   */
  private async pushNewActionWindow() {
    try {
      const actionWindow = this.createPreloadedActionWindow()
      this.preloadedActionWindows.push(actionWindow)
    } catch (error) {
      this.logError('Failed to push new action window:', error as Error)
    }
  }

  /**
   * Pop an action window from the preloadedActionWindows queue
   * Immediately returns a window and asynchronously creates a new one
   * @returns {BrowserWindow} The action window
   */
  private popActionWindow() {
    // Get a window from the preloaded queue or create a new one if empty
    const actionWindow = this.preloadedActionWindows.pop() || this.createPreloadedActionWindow()

    // Set up event listeners for this instance
    actionWindow.on('closed', () => {
      this.actionWindows.delete(actionWindow)
      if (!actionWindow.isDestroyed()) {
        actionWindow.destroy()
      }
    })

    //remember the action window size
    actionWindow.on('resized', () => {
      if (this.isRemeberWinSize) {
        this.lastActionWindowSize = {
          width: actionWindow.getBounds().width,
          height: actionWindow.getBounds().height
        }
      }
    })

    this.actionWindows.add(actionWindow)

    // Asynchronously create a new preloaded window
    this.pushNewActionWindow()

    return actionWindow
  }

  public processAction(actionItem: ActionItem): void {
    const actionWindow = this.popActionWindow()

    actionWindow.webContents.send(IpcChannel.Selection_UpdateActionData, actionItem)

    this.showActionWindow(actionWindow)
  }

  /**
   * Show action window with proper positioning relative to toolbar
   * Ensures window stays within screen boundaries
   * @param actionWindow Window to position and show
   */
  private showActionWindow(actionWindow: BrowserWindow) {
    let actionWindowWidth = this.ACTION_WINDOW_WIDTH
    let actionWindowHeight = this.ACTION_WINDOW_HEIGHT

    //if remember win size is true, use the last remembered size
    if (this.isRemeberWinSize) {
      actionWindowWidth = this.lastActionWindowSize.width
      actionWindowHeight = this.lastActionWindowSize.height
    }

    //center way
    if (!this.isFollowToolbar || !this.toolbarWindow) {
      if (this.isRemeberWinSize) {
        actionWindow.setBounds({
          width: actionWindowWidth,
          height: actionWindowHeight
        })
      }

      actionWindow.show()
      this.hideToolbar()
      return
    }

    //follow toolbar

    const toolbarBounds = this.toolbarWindow!.getBounds()
    const display = screen.getDisplayNearestPoint({ x: toolbarBounds.x, y: toolbarBounds.y })
    const workArea = display.workArea
    const GAP = 6 // 6px gap from screen edges

    //make sure action window is inside screen
    if (actionWindowWidth > workArea.width - 2 * GAP) {
      actionWindowWidth = workArea.width - 2 * GAP
    }

    if (actionWindowHeight > workArea.height - 2 * GAP) {
      actionWindowHeight = workArea.height - 2 * GAP
    }

    // Calculate initial position to center action window horizontally below toolbar
    let posX = Math.round(toolbarBounds.x + (toolbarBounds.width - actionWindowWidth) / 2)
    let posY = Math.round(toolbarBounds.y)

    // Ensure action window stays within screen boundaries with a small gap
    if (posX + actionWindowWidth > workArea.x + workArea.width) {
      posX = workArea.x + workArea.width - actionWindowWidth - GAP
    } else if (posX < workArea.x) {
      posX = workArea.x + GAP
    }
    if (posY + actionWindowHeight > workArea.y + workArea.height) {
      // If window would go below screen, try to position it above toolbar
      posY = workArea.y + workArea.height - actionWindowHeight - GAP
    } else if (posY < workArea.y) {
      posY = workArea.y + GAP
    }

    actionWindow.setPosition(posX, posY, false)
    //KEY to make window not resize
    actionWindow.setBounds({
      width: actionWindowWidth,
      height: actionWindowHeight,
      x: posX,
      y: posY
    })

    actionWindow.show()
  }

  public closeActionWindow(actionWindow: BrowserWindow): void {
    actionWindow.close()
  }

  public minimizeActionWindow(actionWindow: BrowserWindow): void {
    actionWindow.minimize()
  }

  public pinActionWindow(actionWindow: BrowserWindow, isPinned: boolean): void {
    actionWindow.setAlwaysOnTop(isPinned)
  }

  /**
   * Update trigger mode behavior
   * Switches between selection-based and alt-key based triggering
   * Manages appropriate event listeners for each mode
   */
  private processTriggerMode() {
    if (this.triggerMode === TriggerMode.Selected) {
      if (this.isCtrlkeyListenerActive) {
        this.selectionHook!.off('key-down', this.handleKeyDownCtrlkeyMode)
        this.selectionHook!.off('key-up', this.handleKeyUpCtrlkeyMode)

        this.isCtrlkeyListenerActive = false
      }

      this.selectionHook!.setSelectionPassiveMode(false)
    } else if (this.triggerMode === TriggerMode.Ctrlkey) {
      if (!this.isCtrlkeyListenerActive) {
        this.selectionHook!.on('key-down', this.handleKeyDownCtrlkeyMode)
        this.selectionHook!.on('key-up', this.handleKeyUpCtrlkeyMode)

        this.isCtrlkeyListenerActive = true
      }

      this.selectionHook!.setSelectionPassiveMode(true)
    }
  }

  public writeToClipboard(text: string): boolean {
    return this.selectionHook?.writeToClipboard(text) ?? false
  }

  /**
   * Register IPC handlers for communication with renderer process
   * Handles toolbar, action window, and selection-related commands
   */
  public static registerIpcHandler(): void {
    if (this.isIpcHandlerRegistered) return

    ipcMain.handle(IpcChannel.Selection_ToolbarHide, () => {
      selectionService?.hideToolbar()
    })

    ipcMain.handle(IpcChannel.Selection_WriteToClipboard, (_, text: string) => {
      return selectionService?.writeToClipboard(text) ?? false
    })

    ipcMain.handle(IpcChannel.Selection_ToolbarDetermineSize, (_, width: number, height: number) => {
      selectionService?.determineToolbarSize(width, height)
    })

    ipcMain.handle(IpcChannel.Selection_SetEnabled, (_, enabled: boolean) => {
      configManager.setSelectionAssistantEnabled(enabled)
    })

    ipcMain.handle(IpcChannel.Selection_SetTriggerMode, (_, triggerMode: string) => {
      configManager.setSelectionAssistantTriggerMode(triggerMode)
    })

    ipcMain.handle(IpcChannel.Selection_SetFollowToolbar, (_, isFollowToolbar: boolean) => {
      configManager.setSelectionAssistantFollowToolbar(isFollowToolbar)
    })

    ipcMain.handle(IpcChannel.Selection_SetRemeberWinSize, (_, isRemeberWinSize: boolean) => {
      configManager.setSelectionAssistantRemeberWinSize(isRemeberWinSize)
    })

    ipcMain.handle(IpcChannel.Selection_SetFilterMode, (_, filterMode: string) => {
      configManager.setSelectionAssistantFilterMode(filterMode)
    })

    ipcMain.handle(IpcChannel.Selection_SetFilterList, (_, filterList: string[]) => {
      configManager.setSelectionAssistantFilterList(filterList)
    })

    ipcMain.handle(IpcChannel.Selection_ProcessAction, (_, actionItem: ActionItem) => {
      selectionService?.processAction(actionItem)
    })

    ipcMain.handle(IpcChannel.Selection_ActionWindowClose, (event) => {
      const actionWindow = BrowserWindow.fromWebContents(event.sender)
      if (actionWindow) {
        selectionService?.closeActionWindow(actionWindow)
      }
    })

    ipcMain.handle(IpcChannel.Selection_ActionWindowMinimize, (event) => {
      const actionWindow = BrowserWindow.fromWebContents(event.sender)
      if (actionWindow) {
        selectionService?.minimizeActionWindow(actionWindow)
      }
    })

    ipcMain.handle(IpcChannel.Selection_ActionWindowPin, (event, isPinned: boolean) => {
      const actionWindow = BrowserWindow.fromWebContents(event.sender)
      if (actionWindow) {
        selectionService?.pinActionWindow(actionWindow, isPinned)
      }
    })

    this.isIpcHandlerRegistered = true
  }

  private logInfo(message: string) {
    isDev && Logger.info('[SelectionService] Info: ', message)
  }

  private logError(...args: [...string[], Error]) {
    Logger.error('[SelectionService] Error: ', ...args)
  }
}

/**
 * Initialize selection service when app starts
 * Sets up config subscription and starts service if enabled
 * @returns {boolean} Success status of initialization
 */
export function initSelectionService(): boolean {
  if (!isWin) return false

  configManager.subscribe(ConfigKeys.SelectionAssistantEnabled, (enabled: boolean) => {
    //avoid closure
    const ss = SelectionService.getInstance()
    if (!ss) {
      Logger.error('SelectionService not initialized: instance is null')
      return
    }

    if (enabled) {
      ss.start()
    } else {
      ss.stop()
    }
  })

  if (!configManager.getSelectionAssistantEnabled()) return false

  const ss = SelectionService.getInstance()
  if (!ss) {
    Logger.error('SelectionService not initialized: instance is null')
    return false
  }

  return ss.start()
}

const selectionService = SelectionService.getInstance()

export default selectionService
