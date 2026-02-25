<script setup>
import jsQR from 'jsqr'
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const pwaState = inject('pwaState', {
  needRefresh: false,
  offlineReady: false,
  updateServiceWorker: () => {},
})

const appVersion = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__
const iosTipStorageKey = 'qr-pwa-hide-ios-tip'
const androidTipStorageKey = 'qr-pwa-hide-android-tip'
const installedStorageKey = 'qr-pwa-installed'

const currentView = ref('scanner')
const resultText = ref('')
const statusText = ref('等待相機啟動...')
const cameraError = ref('')
const copyMessage = ref('')
const showIosTip = ref(false)
const showAndroidTip = ref(false)
const isRequestingPermission = ref(false)

const videoRef = ref(null)
const canvasRef = ref(null)

let mediaStream = null
let rafId = 0

const openableUrl = computed(() => normalizeUrl(resultText.value))

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent)
}

function isAndroidDevice() {
  return /android/i.test(window.navigator.userAgent)
}

// 判斷目前是否以已安裝的主畫面模式（standalone）啟動 App。
function isStandaloneMode() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  )
}

function isInstalled() {
  return isStandaloneMode() || window.localStorage.getItem(installedStorageKey) === '1'
}

function normalizeUrl(value) {
  const text = value.trim()
  if (!text) return ''

  try {
    return new URL(text).toString()
  } catch (_error) {
    try {
      return new URL(`https://${text}`).toString()
    } catch (_secondError) {
      return ''
    }
  }
}

async function requestCameraPermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraError.value = '此裝置或瀏覽器不支援相機存取。'
    statusText.value = '無法啟動掃碼'
    return false
  }

  statusText.value = '請求相機權限中...'

  if (navigator.permissions?.query) {
    try {
      const permissionStatus = await navigator.permissions.query({ name: 'camera' })
      if (permissionStatus.state === 'granted') {
        return true
      }
      if (permissionStatus.state === 'denied') {
        cameraError.value = '相機權限已被拒絕，請到瀏覽器站點設定將相機改為允許後，再點「重新啟動掃碼」。'
        statusText.value = '等待相機權限'
        return false
      }
    } catch (_error) {
      // 部分瀏覽器不支援 camera 權限查詢，改用 getUserMedia 直接觸發授權。
    }
  }

  try {
    const probeStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    })
    probeStream.getTracks().forEach((track) => track.stop())
    return true
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      cameraError.value = '相機權限已被拒絕，請到瀏覽器站點設定將相機改為允許後，再點「重新啟動掃碼」。'
      statusText.value = '等待相機權限'
      return false
    }

    cameraError.value = '尚未取得相機權限，請允許後再試一次。'
    statusText.value = '無法啟動掃碼'
    return false
  }
}

async function startScanner() {
  stopScanner()
  copyMessage.value = ''
  cameraError.value = ''
  statusText.value = '啟動相機中...'
  currentView.value = 'scanner'
  await nextTick()

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraError.value = '此裝置或瀏覽器不支援相機存取。'
    statusText.value = '無法啟動掃碼'
    return
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    })

    if (!videoRef.value) {
      cameraError.value = '掃碼畫面尚未準備完成，請再試一次。'
      statusText.value = '無法啟動掃碼'
      return
    }
    videoRef.value.srcObject = mediaStream
    await videoRef.value.play()

    statusText.value = '請將 QR Code 放入畫面中。'
    rafId = window.requestAnimationFrame(scanFrame)
  } catch (error) {
    cameraError.value = '相機權限被拒絕，請允許後再試一次。'
    statusText.value = '無法啟動掃碼'
  }
}

async function restartScanner() {
  if (isRequestingPermission.value) return
  isRequestingPermission.value = true
  try {
    const hasPermission = await requestCameraPermission()
    if (!hasPermission) return
    await startScanner()
  } finally {
    isRequestingPermission.value = false
  }
}

function stopScanner() {
  if (rafId) {
    window.cancelAnimationFrame(rafId)
    rafId = 0
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop())
    mediaStream = null
  }

  if (videoRef.value) {
    videoRef.value.srcObject = null
  }
}

function scanFrame() {
  if (!videoRef.value || !canvasRef.value) {
    rafId = window.requestAnimationFrame(scanFrame)
    return
  }

  if (videoRef.value.readyState < 2) {
    rafId = window.requestAnimationFrame(scanFrame)
    return
  }

  const width = videoRef.value.videoWidth
  const height = videoRef.value.videoHeight
  if (!width || !height) {
    rafId = window.requestAnimationFrame(scanFrame)
    return
  }

  canvasRef.value.width = width
  canvasRef.value.height = height
  const ctx = canvasRef.value.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(videoRef.value, 0, 0, width, height)

  const imageData = ctx.getImageData(0, 0, width, height)
  const decoded = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'dontInvert',
  })

  if (decoded?.data) {
    resultText.value = decoded.data.trim()
    statusText.value = '掃碼成功'
    currentView.value = 'result'
    stopScanner()
    return
  }

  rafId = window.requestAnimationFrame(scanFrame)
}

function backToScanner() {
  resultText.value = ''
  copyMessage.value = ''
  startScanner()
}

async function copyText() {
  if (!resultText.value) return

  if (!navigator.clipboard?.writeText) {
    copyMessage.value = '此瀏覽器不支援自動複製，請手動複製內容'
    return
  }

  try {
    await navigator.clipboard.writeText(resultText.value)
    copyMessage.value = '已複製到剪貼簿'
  } catch (_error) {
    copyMessage.value = '複製失敗，請手動長按文字複製'
  }
}

function openLink() {
  if (!openableUrl.value) return
  window.open(openableUrl.value, '_blank', 'noopener,noreferrer')
}

function dismissIosTip() {
  showIosTip.value = false
  window.localStorage.setItem(iosTipStorageKey, '1')
}

function dismissAndroidTip() {
  showAndroidTip.value = false
  window.localStorage.setItem(androidTipStorageKey, '1')
}

function dismissUpdate() {
  pwaState.needRefresh = false
}

function applyUpdate() {
  pwaState.updateServiceWorker()
}

function handleAppInstalled() {
  window.localStorage.setItem(installedStorageKey, '1')
  showAndroidTip.value = false
}

onMounted(() => {
  const isAppInstalled = isInstalled()
  const hideIosTip = window.localStorage.getItem(iosTipStorageKey) === '1'
  const hideAndroidTip = window.localStorage.getItem(androidTipStorageKey) === '1'

  if (isStandaloneMode()) {
    window.localStorage.setItem(installedStorageKey, '1')
  }

  showIosTip.value = isIosDevice() && !isAppInstalled && !hideIosTip
  showAndroidTip.value = isAndroidDevice() && !isAppInstalled && !hideAndroidTip
  window.addEventListener('appinstalled', handleAppInstalled)
  startScanner()
})

onBeforeUnmount(() => {
  window.removeEventListener('appinstalled', handleAppInstalled)
  stopScanner()
})
</script>

<template>
  <main class="app-shell">
    <header class="app-header">
      <h1>QR Code 離線掃碼</h1>
      <span class="version-badge">v{{ appVersion }}</span>
    </header>

    <p class="subtitle">開啟 App 即可掃碼；在離線狀態也能正常使用。</p>

    <section v-if="showIosTip" class="ios-tip">
      <p>iOS 溫馨提示：請用 Safari 開啟後點「分享」→「加入主畫面」，可獲得完整 PWA 體驗。</p>
      <button class="btn btn-ghost" @click="dismissIosTip">知道了</button>
    </section>

    <section v-if="showAndroidTip" class="ios-tip">
      <p>Android 溫馨提示：請在 Chrome 點右上角選單「加到主畫面」，可獲得完整 PWA 體驗。</p>
      <button class="btn btn-ghost" @click="dismissAndroidTip">知道了</button>
    </section>

    <section v-if="currentView === 'scanner'" class="scanner-view">
      <div class="camera-frame">
        <video ref="videoRef" playsinline autoplay muted></video>
      </div>
      <canvas ref="canvasRef" class="hidden-canvas"></canvas>

      <p class="status">{{ statusText }}</p>
      <p v-if="cameraError" class="error">{{ cameraError }}</p>

      <button class="btn btn-primary" :disabled="isRequestingPermission" @click="restartScanner">
        {{ isRequestingPermission ? '請求權限中...' : '重新啟動掃碼' }}
      </button>
    </section>

    <section v-else class="result-view">
      <button class="btn btn-ghost top-back" @click="backToScanner">返回重新掃碼</button>

      <pre class="result-box">{{ resultText }}</pre>

      <div class="result-actions">
        <button class="btn btn-primary" @click="copyText">複製內容</button>
        <button class="btn btn-secondary" :disabled="!openableUrl" @click="openLink">打開連結</button>
      </div>

      <p class="hint">
        {{
          copyMessage ||
          (openableUrl
            ? '此內容可直接開啟連結。'
            : '掃碼內容不是網址，仍可使用「複製內容」。')
        }}
      </p>
    </section>

    <div v-if="pwaState.offlineReady" class="toast">離線模式已就緒，可在無網路下掃碼。</div>

    <section v-if="pwaState.needRefresh" class="update-mask">
      <div class="update-card">
        <h2>有新版本可更新</h2>
        <p>建議更新後再繼續使用，確保掃碼與離線快取為最新版本。</p>
        <div class="update-actions">
          <button class="btn btn-ghost" @click="dismissUpdate">稍後</button>
          <button class="btn btn-primary" @click="applyUpdate">立即更新</button>
        </div>
      </div>
    </section>
  </main>
</template>
