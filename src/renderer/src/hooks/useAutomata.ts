import { IpcChannel } from '@shared/IpcChannel'

window.electron.ipcRenderer.on(IpcChannel.Automata_Click, (_event, { key }: { key: string }) => {
  console.log('Automata_Click', { key })
  const element: any = document.getElementsByClassName(key)[0]
  if (!element) {
    console.log('Automata_Click element not found', { key })
    return
  }
  element.click()
})

window.electron.ipcRenderer.on(
  IpcChannel.Automata_UpdateTextarea,
  (_event, { key, text }: { key: string; text: string }) => {
    console.log('Automata_UpdateTextarea', { key, text })
    const element: any = document.getElementsByClassName(key)[0]
    if (!element) {
      console.log('Automata_UpdateTextarea element not found', { key })
      return
    }

    // Focus the element first
    element.focus()

    // Set the value directly
    const previousValue = element.value
    element.value = text

    // Create a proper React synthetic event for onChange
    const changeEvent = new Event('change', { bubbles: true })
    Object.defineProperty(changeEvent, 'target', {
      writable: false,
      value: element
    })
    Object.defineProperty(changeEvent, 'currentTarget', {
      writable: false,
      value: element
    })

    // Create a proper React synthetic event for onInput
    const inputEvent = new Event('input', { bubbles: true })
    Object.defineProperty(inputEvent, 'target', {
      writable: false,
      value: element
    })
    Object.defineProperty(inputEvent, 'currentTarget', {
      writable: false,
      value: element
    })

    // Simulate typing by dispatching input event first, then change
    element.dispatchEvent(inputEvent)
    element.dispatchEvent(changeEvent)

    // Also trigger React's internal event handlers if they exist
    const reactInternalInstance = element._valueTracker
    if (reactInternalInstance) {
      reactInternalInstance.setValue(previousValue)
    }

    // Force React to re-render by simulating a property change
    const tracker = element._valueTracker
    if (tracker) {
      tracker.setValue(previousValue)
    }

    // Create and dispatch a more comprehensive input event that React will recognize
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(element, text)

      const inputEventToTriggerReact = new Event('input', { bubbles: true })
      element.dispatchEvent(inputEventToTriggerReact)
    }

    // Trigger resize if it's a textarea (for auto-resize functionality)
    if (element.tagName.toLowerCase() === 'textarea') {
      // Trigger resize event
      const resizeEvent = new Event('input', { bubbles: true })
      element.dispatchEvent(resizeEvent)

      // Also manually trigger any resize logic
      setTimeout(() => {
        element.style.height = 'auto'
        element.style.height = element.scrollHeight > 400 ? '400px' : `${element.scrollHeight}px`
      }, 0)
    }
  }
)

export const useAutomata = () => {}
