<script setup lang="ts">
const props = withDefaults(defineProps<{
  modelValue: boolean
  title: string
  eyebrow?: string
  size?: 'medium' | 'large' | 'full'
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
}>(), {
  eyebrow: '',
  size: 'medium',
  closeOnBackdrop: true,
  closeOnEscape: true
})

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  close: []
  afterClose: []
}>()

const dialog = ref<HTMLElement | null>(null)
const titleId = useId()
let previouslyFocused: HTMLElement | null = null

function close() {
  emit('update:modelValue', false)
  emit('close')
}

function onBackdropClick() {
  if (props.closeOnBackdrop) close()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.closeOnEscape) {
    event.preventDefault()
    close()
    return
  }
  if (event.key !== 'Tab' || !dialog.value) return

  const focusable = [...dialog.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hasAttribute('hidden'))
  if (!focusable.length) {
    event.preventDefault()
    dialog.value.focus()
    return
  }

  const first = focusable[0]!
  const last = focusable.at(-1)!
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.modelValue, async (isOpen) => {
  if (!import.meta.client) return
  if (isOpen) {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.documentElement.classList.add('modal-open')
    await nextTick()
    dialog.value?.focus()
  } else {
    document.documentElement.classList.remove('modal-open')
    previouslyFocused?.focus()
    previouslyFocused = null
  }
}, { immediate: true })

onBeforeUnmount(() => {
  if (!import.meta.client) return
  document.documentElement.classList.remove('modal-open')
  previouslyFocused?.focus()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="app-modal" @after-leave="emit('afterClose')">
      <div v-if="modelValue" class="modal-backdrop" @click.self="onBackdropClick">
        <section
          ref="dialog"
          class="modal"
          :class="`modal--${size}`"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
          @keydown="onKeydown"
        >
          <header class="modal__header">
            <slot name="header">
              <div class="modal__heading">
                <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
                <h2 :id="titleId" class="modal__title">{{ title }}</h2>
              </div>
            </slot>
            <button class="icon-button modal__close" type="button" aria-label="Закрыть окно" @click="close">×</button>
          </header>
          <div class="modal__body"><slot /></div>
          <footer v-if="$slots.footer" class="modal__footer"><slot name="footer" /></footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
html.modal-open { overflow: hidden; }
.modal-backdrop {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(3 14 10 / .62);
  -webkit-backdrop-filter: blur(7px);
  backdrop-filter: blur(7px);
}
.modal {
  display: flex;
  width: min(620px, 100%);
  max-height: calc(100dvh - 48px);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 21px;
  outline: none;
  background: var(--surface);
  box-shadow: 0 30px 90px rgb(0 0 0 / .3);
}
.modal--large { width: min(1040px, 100%); }
.modal--full { width: min(1400px, 100%); height: calc(100dvh - 48px); }
.modal__header {
  display: flex;
  flex: 0 0 auto;
  align-items: start;
  justify-content: space-between;
  gap: 20px;
  padding: 22px 24px;
  border-bottom: 1px solid var(--line);
}
.modal__heading { min-width: 0; }
.modal__heading .eyebrow { margin-bottom: 6px; }
.modal__title { margin: 0; font-size: clamp(1.2rem, 3vw, 1.75rem); font-weight: 450; line-height: 1.2; overflow-wrap: anywhere; }
.modal__close { font-size: 1.5rem; line-height: 1; }
.modal__body { min-height: 0; flex: 1 1 auto; overflow: auto; padding: 24px; overscroll-behavior: contain; }
.modal__footer { display: flex; flex: 0 0 auto; justify-content: flex-end; gap: 10px; padding: 16px 24px; border-top: 1px solid var(--line); }
.app-modal-enter-active, .app-modal-leave-active { transition: opacity .18s ease; }
.app-modal-enter-active .modal, .app-modal-leave-active .modal { transition: transform .18s ease, opacity .18s ease; }
.app-modal-enter-from, .app-modal-leave-to { opacity: 0; }
.app-modal-enter-from .modal, .app-modal-leave-to .modal { opacity: 0; transform: translateY(12px) scale(.985); }

@media (max-width: 560px) {
  .modal-backdrop { align-items: end; padding: 8px; }
  .modal, .modal--large, .modal--full { width: 100%; max-height: calc(100dvh - 16px); border-radius: 18px; }
  .modal--full { height: calc(100dvh - 16px); }
  .modal__header { padding: 18px; }
  .modal__body { padding: 18px; }
  .modal__footer { padding: 14px 18px; }
}

@media (prefers-reduced-motion: reduce) {
  .app-modal-enter-active, .app-modal-leave-active, .app-modal-enter-active .modal, .app-modal-leave-active .modal { transition-duration: .01ms; }
}
</style>
