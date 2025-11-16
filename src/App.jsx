import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Niivue } from '@niivue/niivue'
import { runInference } from '../viewer-mainthread.js'
import { inferenceModelsList, tuttuViewerOpts } from '../viewer-parameters.js'
import { isChrome, localSystemDetails } from '../viewer-diagnostics.js'
import MyWorker from '../viewer-webworker.js?worker'

const DEFAULT_LOCATION_LINE = 'Drag and Drop any NIfTI image'
const DRAG_MODE_OPTIONS = ['none', 'contrast', 'measurement', 'pan/zoom', 'slicer3D']
const DRAW_ACTION_OPTIONS = [
  { label: 'Undo', value: 0 },
  { label: 'Append', value: 1 },
  { label: 'Remove', value: 2 },
]
const PEN_OPTIONS = [
  { label: 'Off', value: -1 },
  { label: 'On', value: 2 },
  { label: 'Filled', value: 10 },
  { label: 'Erase', value: 0 },
]

const cloneOptions = () =>
  typeof structuredClone === 'function'
    ? structuredClone(tuttuViewerOpts)
    : JSON.parse(JSON.stringify(tuttuViewerOpts))

export default function App() {
  const canvasRef = useRef(null)
  const nvRef = useRef(null)
  const workerRef = useRef(null)
  const diagnosticsStringRef = useRef('')
  const missingLabelStatusRef = useRef('')

  const [backgroundOpacity, setBackgroundOpacity] = useState(255)
  const [overlayOpacity, setOverlayOpacity] = useState(128)
  const [selectedModelIndex, setSelectedModelIndex] = useState('')
  const [modelWarning, setModelWarning] = useState('')
  const [useWorker, setUseWorker] = useState(false)
  const [clipPlaneEnabled, setClipPlaneEnabled] = useState(false)
  const [dragMode, setDragMode] = useState(3)
  const [penMode, setPenMode] = useState(-1)
  const [drawAction, setDrawAction] = useState('')
  const [locationLines, setLocationLines] = useState([DEFAULT_LOCATION_LINE])
  const [progress, setProgress] = useState(0)
  const [memoryStatus, setMemoryStatus] = useState({ text: 'Memory OK', color: 'green' })
  const [starCount, setStarCount] = useState(0)
  const [isRunning, setIsRunning] = useState(false)
  const [isVolumeReady, setIsVolumeReady] = useState(false)
  const [isCompactLayout, setIsCompactLayout] = useState(false)
  const [controlsOpen, setControlsOpen] = useState(true)

  const models = useMemo(() => inferenceModelsList, [])

  const updateBackgroundOpacity = useCallback(
    (value) => {
      const nv = nvRef.current
      if (!nv || nv.volumes.length === 0) return
      nv.setOpacity(0, value / 255)
      nv.updateGLVolume()
    },
    [],
  )

  const updateOverlayOpacity = useCallback(
    (value) => {
      const nv = nvRef.current
      if (!nv || nv.volumes.length < 2) return
      nv.setOpacity(1, value / 255)
    },
    [],
  )

  const closeAllOverlays = useCallback(async () => {
    const nv = nvRef.current
    if (!nv) return
    while (nv.volumes.length > 1) {
      await nv.removeVolume(nv.volumes[1])
    }
  }, [])

  const ensureConformed = useCallback(async () => {
    const nv = nvRef.current
    if (!nv || nv.volumes.length === 0) return
    const nii = nv.volumes[0]
    let isConformed =
      nii.dims[1] === 256 &&
      nii.dims[2] === 256 &&
      nii.dims[3] === 256 &&
      nii.img instanceof Uint8Array &&
      nii.img.length === 256 * 256 * 256
    if (nii.permRAS[0] !== -1 || nii.permRAS[1] !== 3 || nii.permRAS[2] !== -2) {
      isConformed = false
    }
    if (isConformed) return
    const nii2 = await nv.conform(nii, false)
    await nv.removeVolume(nii)
    await nv.addVolume(nii2)
  }, [])

  const fetchJSON = useCallback(async (fnm) => {
    // Resolve relative paths to absolute paths for Vite
    let url = fnm
    if (fnm.startsWith('./')) {
      url = fnm.replace('./', '/')
    } else if (!fnm.startsWith('/') && !fnm.startsWith('http')) {
      url = '/' + fnm
    }
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Unable to load ${url}: ${response.statusText}`)
    }
    return response.json()
  }, [])

  const getUniqueValuesAndCounts = useCallback(async (uint8Array) => {
    const countsMap = new Map()
    for (let i = 0; i < uint8Array.length; i += 1) {
      const value = uint8Array[i]
      countsMap.set(value, (countsMap.get(value) ?? 0) + 1)
    }
    return Array.from(countsMap, ([value, count]) => ({ value, count }))
  }, [])

  const createLabeledCounts = useCallback((uniqueValuesAndCounts, labelStrings) => {
    if (uniqueValuesAndCounts.length !== labelStrings.length) {
      missingLabelStatusRef.current = 'Failed to Predict Labels - '
      console.error(
        'Mismatch in lengths: uniqueValuesAndCounts has',
        uniqueValuesAndCounts.length,
        'items, but labelStrings has',
        labelStrings.length,
        'items.',
      )
    }
    return labelStrings.map((label, index) => {
      const entry = uniqueValuesAndCounts.find((item) => item.value === index)
      const countText = entry ? `${entry.count} mm3` : 'Missing'
      if (countText === 'Missing') {
        missingLabelStatusRef.current += `${label}, `
      }
      return `${label}   ${countText}`
    })
  }, [])

  const reportTelemetry = useCallback(
    async (statData) => {
      let stats = statData
      if (typeof stats === 'string' || stats instanceof String) {
        const list = JSON.parse(stats)
        const array = []
        for (const key in list) {
          array[key] = list[key]
        }
        stats = array
      }
      const enhancedStats = await localSystemDetails(stats, nvRef.current?.gl)
      let diagnosticsString =
        ':: Diagnostics can help resolve issues https://github.com/tuttucodes/3d-Mri-Viewer/issues ::\n'
      for (const key in enhancedStats) {
        diagnosticsString += `${key}: ${enhancedStats[key]}\n`
      }
      diagnosticsStringRef.current = diagnosticsString
    },
    [],
  )

  const handleCallbackUI = useCallback(
    (message = '', progressFrac = -1, modalMessage = '', statData = []) => {
      if (message) {
        setLocationLines(message.split('   '))
      }
      if (Number.isNaN(progressFrac)) {
        setMemoryStatus({ text: 'Memory Issue', color: 'red' })
      } else if (progressFrac >= 0) {
        setProgress(Math.round(progressFrac * 100))
        setMemoryStatus((prev) =>
          prev.text === 'Memory OK' ? prev : { text: 'Memory OK', color: 'green' },
        )
      }
      if (modalMessage) {
        window.alert(modalMessage)
      }
      if (Object.keys(statData).length > 0) {
        reportTelemetry(statData)
      }
    },
    [reportTelemetry],
  )

  const handleCallbackImg = useCallback(
    async (img, opts, modelEntry) => {
      const nv = nvRef.current
      if (!nv) return
      await closeAllOverlays()
      const overlayVolume = await nv.volumes[0].clone()
      overlayVolume.zeroImage()
      overlayVolume.hdr.scl_inter = 0
      overlayVolume.hdr.scl_slope = 1
      overlayVolume.img = new Uint8Array(img)
      const roiVolumes = await getUniqueValuesAndCounts(overlayVolume.img)
      if (modelEntry.colormapPath) {
        try {
          const cmap = await fetchJSON(modelEntry.colormapPath)
          missingLabelStatusRef.current = ''
          const newLabels = createLabeledCounts(roiVolumes, cmap.labels)
          overlayVolume.setColormapLabel({
            R: cmap.R,
            G: cmap.G,
            B: cmap.B,
            labels: newLabels,
          })
          overlayVolume.hdr.intent_code = 1002
        } catch (error) {
          console.error('Error loading colormap:', error)
          // Fall back to default colormap if colormap file fails to load
          let colormap = opts.atlasSelectedColorTable.toLowerCase()
          const cmaps = nv.colormaps()
          if (!cmaps.includes(colormap)) {
            colormap = 'actc'
          }
          overlayVolume.colormap = colormap
        }
      } else {
        let colormap = opts.atlasSelectedColorTable.toLowerCase()
        const cmaps = nv.colormaps()
        if (!cmaps.includes(colormap)) {
          colormap = 'actc'
        }
        overlayVolume.colormap = colormap
      }
      overlayVolume.opacity = overlayOpacity / 255
      await nv.addVolume(overlayVolume)
      updateOverlayOpacity(overlayOpacity)
      setIsRunning(false)
      setProgress(100)
    },
    [closeAllOverlays, createLabeledCounts, fetchJSON, getUniqueValuesAndCounts, overlayOpacity, updateOverlayOpacity],
  )

  const runSegmentation = useCallback(
    async (modelIndex) => {
      if (modelIndex === '' || Number.isNaN(Number(modelIndex))) return
      const index = Number(modelIndex)
      const nv = nvRef.current
      if (!nv || nv.volumes.length === 0) {
        window.alert('Please load an MRI image first before running segmentation.')
        return
      }
      const modelEntry = models[index]
      if (!modelEntry) return
      missingLabelStatusRef.current = ''
      diagnosticsStringRef.current = ''
      await closeAllOverlays()
      await ensureConformed()
      const opts = cloneOptions()
      const url = new URL(window.location.href)
      opts.rootURL = url.origin + url.pathname
      const isLocalhost =
        window.location.hostname === 'localhost' ||
        window.location.hostname === '[::1]' ||
        /^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/.test(window.location.hostname)
      if (isLocalhost) {
        opts.rootURL = `${window.location.protocol}//${window.location.host}`
      }
      setIsRunning(true)
      setProgress(0)
      if (useWorker) {
        if (workerRef.current) {
          console.warn('Unable to start new segmentation: previous call has not completed')
          setIsRunning(false)
          return
        }
        const hdr = {
          datatypeCode: nv.volumes[0].hdr.datatypeCode,
          dims: nv.volumes[0].hdr.dims,
        }
        const worker = new MyWorker({ type: 'module' })
        workerRef.current = worker
        worker.postMessage({
          opts,
          modelEntry,
          niftiHeader: hdr,
          niftiImage: nv.volumes[0].img,
        })
        worker.onmessage = (event) => {
          const { cmd } = event.data
          if (cmd === 'ui') {
            if (event.data.modalMessage) {
              workerRef.current?.terminate()
              workerRef.current = null
              setIsRunning(false)
            }
            handleCallbackUI(
              event.data.message,
              event.data.progressFrac,
              event.data.modalMessage,
              event.data.statData,
            )
          }
          if (cmd === 'img') {
            workerRef.current?.terminate()
            workerRef.current = null
            handleCallbackImg(event.data.img, event.data.opts, event.data.modelEntry)
          }
        }
        worker.onerror = (error) => {
          console.error('Worker error:', error)
          workerRef.current?.terminate()
          workerRef.current = null
          setIsRunning(false)
          window.alert(`Segmentation error: ${error.message || 'Unknown error'}`)
        }
      } else {
        try {
          await runInference(
            opts,
            modelEntry,
            nv.volumes[0].hdr,
            nv.volumes[0].img,
            handleCallbackImg,
            handleCallbackUI,
          )
        } catch (error) {
          console.error('Inference error:', error)
          setIsRunning(false)
          window.alert(`Segmentation error: ${error.message || 'Unknown error'}`)
        }
      }
    },
    [
      closeAllOverlays,
      ensureConformed,
      handleCallbackImg,
      handleCallbackUI,
      models,
      useWorker,
    ],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const defaults = {
      backColor: [0.4, 0.4, 0.4, 1],
      show3Dcrosshair: true,
      onLocationChange: (data) => {
        setLocationLines(
          data.string
            .split('   ')
            .map((value) => value.trim())
            .filter(Boolean),
        )
      },
    }
    const nv = new Niivue(defaults)
    nvRef.current = nv
    nv.attachToCanvas(canvas)
    nv.opts.dragMode = nv.dragModes.pan
    nv.opts.multiplanarForceRender = true
    nv.opts.yoke3Dto2DZoom = true
    nv.opts.crosshairGap = 11
    nv.setInterpolation(true)
    nv.onImageLoaded = () => {
      setIsVolumeReady(true)
      updateBackgroundOpacity(backgroundOpacity)
    }
    
    // Try to load default volume, but don't fail if it doesn't exist
    const possiblePaths = ['./public/t1_crop.nii.gz', './t1_crop.nii.gz', '/public/t1_crop.nii.gz']
    let loaded = false
    const tryLoadDefault = async () => {
      for (const path of possiblePaths) {
        try {
          await nv.loadVolumes([{ url: path }])
          loaded = true
          break
        } catch (e) {
          // Try next path
        }
      }
      if (!loaded) {
        console.log('Default volume not found, waiting for user to load file')
        setIsVolumeReady(false)
      }
    }
    tryLoadDefault()

    // Set up drag and drop handlers
    const handleDragOver = (e) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const handleDragEnter = (e) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const handleDrop = async (e) => {
      e.preventDefault()
      e.stopPropagation()
      const files = e.dataTransfer.files
      if (files.length > 0) {
        const file = files[0]
        if (file.name.endsWith('.nii') || file.name.endsWith('.nii.gz') || file.name.endsWith('.gz')) {
          const url = URL.createObjectURL(file)
          try {
            await nv.loadVolumes([{ url }])
            setIsVolumeReady(true)
            updateBackgroundOpacity(backgroundOpacity)
          } catch (error) {
            console.error('Error loading file:', error)
            window.alert('Error loading file. Please make sure it is a valid NIfTI file.')
          } finally {
            URL.revokeObjectURL(url)
          }
        } else {
          window.alert('Please drop a valid NIfTI file (.nii or .nii.gz)')
        }
      }
    }

    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('drop', handleDrop)

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate()
        workerRef.current = null
      }
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('drop', handleDrop)
      nvRef.current = null
    }
  }, [backgroundOpacity, updateBackgroundOpacity])

  useEffect(() => {
    updateBackgroundOpacity(backgroundOpacity)
  }, [backgroundOpacity, updateBackgroundOpacity])

  useEffect(() => {
    updateOverlayOpacity(overlayOpacity)
  }, [overlayOpacity, updateOverlayOpacity])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return
    nv.opts.dragMode = dragMode
  }, [dragMode])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return
    if (clipPlaneEnabled) {
      nv.setClipPlane([0, 0, 90])
    } else {
      nv.setClipPlane([2, 0, 90])
    }
  }, [clipPlaneEnabled])

  useEffect(() => {
    const detectChrome = async () => {
      try {
        const chrome = await isChrome()
        setUseWorker(chrome)
      } catch (error) {
        console.warn('Error detecting Chrome browser', error)
        setUseWorker(false)
      }
    }
    detectChrome()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch('https://api.github.com/repos/tuttucodes/3d-Mri-Viewer', { signal: controller.signal })
      .then((response) => response.json())
      .then((data) => {
        if (typeof data.stargazers_count === 'number') {
          setStarCount(data.stargazers_count)
        }
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          console.error('Error fetching star count:', error)
        }
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (selectedModelIndex === '') return
    const index = Number(selectedModelIndex)
    const modelEntry = models[index]
    setModelWarning(modelEntry?.warning ?? '')
    runSegmentation(selectedModelIndex)
  }, [models, runSegmentation, selectedModelIndex])

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const modelParam = urlParams.get('model')
    if (modelParam !== null) {
      const index = Number(modelParam)
      if (!Number.isNaN(index) && index >= 0 && index < models.length) {
        setSelectedModelIndex(String(index))
      }
    }
  }, [models.length])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mediaQuery = window.matchMedia('(max-width: 900px)')
    const applyLayout = (matches) => {
      setIsCompactLayout(matches)
      setControlsOpen(matches ? false : true)
    }
    applyLayout(mediaQuery.matches)
    const listener = (event) => applyLayout(event.matches)
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', listener)
    } else {
      mediaQuery.addListener(listener)
    }
    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', listener)
      } else {
        mediaQuery.removeListener(listener)
      }
    }
  }, [])

  const handleClipPlaneToggle = (event) => {
    setClipPlaneEnabled(event.target.checked)
  }

  const handleBackgroundOpacityChange = (event) => {
    setBackgroundOpacity(Number(event.target.value))
  }

  const handleOverlayOpacityChange = (event) => {
    setOverlayOpacity(Number(event.target.value))
  }

  const handleModelChange = (event) => {
    setSelectedModelIndex(event.target.value)
  }

  const handleWorkerToggle = (event) => {
    const checked = event.target.checked
    setUseWorker(checked)
    if (checked && selectedModelIndex !== '') {
      runSegmentation(selectedModelIndex)
    }
  }

  const handlePenModeChange = (event) => {
    const mode = Number(event.target.value)
    setPenMode(mode)
    const nv = nvRef.current
    if (!nv) return
    nv.setDrawingEnabled(mode >= 0)
    if (mode >= 0) {
      nv.setPenValue(mode & 7, mode > 7)
    } else {
      nv.setDrawingEnabled(false)
    }
  }

  const handleDrawActionChange = async (event) => {
    const mode = event.target.value
    setDrawAction(mode)
    if (mode === '') return
    const nv = nvRef.current
    if (!nv) return
    if (nv.volumes.length < 2) {
      window.alert('No segmentation open (use the Segmentation pull down)')
      setDrawAction('')
      return
    }
    if (!nv.drawBitmap) {
      window.alert('No drawing (hint: use the Draw pull down to select a pen)')
      setDrawAction('')
      return
    }
    const numericMode = Number(mode)
    const img = nv.volumes[1].img
    const draw = await nv.saveImage({ filename: '', isSaveDrawing: true })
    const niiHdrBytes = 352
    const nvox = draw.length
    if (numericMode === 0) {
      nv.drawUndo()
      setDrawAction('')
      return
    }
    if (numericMode === 1) {
      for (let i = 0; i < nvox; i += 1) {
        if (draw[niiHdrBytes + i] > 0) img[i] = 1
      }
    }
    if (numericMode === 2) {
      for (let i = 0; i < nvox; i += 1) {
        if (draw[niiHdrBytes + i] > 0) img[i] = 0
      }
    }
    nv.closeDrawing()
    nv.updateGLVolume()
    nv.setDrawingEnabled(false)
    setPenMode(-1)
    setDrawAction('')
  }

  const handleDragModeChange = (event) => {
    setDragMode(Number(event.target.value))
  }

  const handleDiagnosticsClick = () => {
    let diagnostics = diagnosticsStringRef.current
    const missing = missingLabelStatusRef.current.trim()
    if (missing) {
      diagnostics = diagnostics.replace('Status: OK', `Status: ${missing.slice(0, -1)}`)
    }
    if (!diagnostics) {
      window.alert('No diagnostic string generated: run a model to create diagnostics')
      return
    }
    navigator.clipboard.writeText(diagnostics).catch((error) => {
      console.error('Unable to copy diagnostics to clipboard', error)
    })
    window.alert(`Diagnostics copied to clipboard\n${diagnostics}`)
  }

  const handleAboutClick = () => {
    window.alert('Drag and drop NIfTI images. Use the model selector to choose your segmentation model.')
  }

  const handleSaveSegmentation = () => {
    const nv = nvRef.current
    if (nv?.volumes?.[1]) {
      nv.volumes[1].saveToDisk('segmentation.nii.gz')
    } else {
      window.alert('No segmentation available to save.')
    }
  }

  const handleSaveScene = () => {
    const nv = nvRef.current
    if (!nv) return
    nv.saveDocument('mri-viewer-scene.nvd')
  }

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar-meta">
          <div>
            <h1>
              AI Project · 3D MRI Scan Model
            </h1>
            <p>
              Presented by <strong>Rahul Babu</strong> & <strong>Krishnaa Nair</strong>. Course: <strong>Software Engineering</strong>
              <br />
              Faculty: <strong>Dr Ilavarasi AK</strong>
            </p>
          </div>
          <div className="meta-badges">
            <span className="badge badge-accent">Real-time Inference</span>
            <span className="badge">Niivue + TensorFlow.js</span>
            <span className="badge">Web Worker Ready</span>
          </div>
        </div>
        {isCompactLayout && (
          <button
            type="button"
            className="toolbar-toggle"
            onClick={() => setControlsOpen((prev) => !prev)}
            aria-expanded={controlsOpen}
            aria-controls="toolbar-panels"
          >
            {controlsOpen ? 'Hide Controls' : 'Show Controls'}
          </button>
        )}
        <div
          id="toolbar-panels"
          className={`toolbar-panels ${controlsOpen ? 'open' : 'collapsed'}`}
        >
          <div className="toolbar-section">
          <label>
            Clip Plane
            <input type="checkbox" checked={clipPlaneEnabled} onChange={handleClipPlaneToggle} />
          </label>
          <label>
            Background Opacity
            <input
              type="range"
              min="0"
              max="255"
              value={backgroundOpacity}
              onChange={handleBackgroundOpacityChange}
            />
          </label>
          <label>
            Overlay Opacity
            <input
              type="range"
              min="0"
              max="255"
              value={overlayOpacity}
              onChange={handleOverlayOpacityChange}
            />
          </label>
          <label>
            Load MRI File
            <input
              type="file"
              accept=".nii,.nii.gz,.gz"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const nv = nvRef.current
                if (!nv) return
                const url = URL.createObjectURL(file)
                try {
                  await nv.loadVolumes([{ url }])
                  setIsVolumeReady(true)
                  updateBackgroundOpacity(backgroundOpacity)
                } catch (error) {
                  console.error('Error loading file:', error)
                  window.alert('Error loading file. Please make sure it is a valid NIfTI file.')
                } finally {
                  URL.revokeObjectURL(url)
                }
              }}
              style={{ display: 'block', marginTop: '5px' }}
            />
          </label>
          <label>
            Segmentation Model
            <select value={selectedModelIndex} onChange={handleModelChange}>
              <option value="">Select model</option>
              {models.map((model, index) => (
                <option key={model.id} value={String(index)}>
                  {model.modelName}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={handleSaveSegmentation}>
            Save Segmentation
          </button>
          <button type="button" onClick={handleSaveScene}>
            Save Scene
          </button>
        </div>
          <div className="toolbar-section">
          <label title="Webworkers are faster but not supported by all browsers">
            Use Webworker
            <input type="checkbox" checked={useWorker} onChange={handleWorkerToggle} />
          </label>
          <label>
            Draw
            <select value={penMode} onChange={handlePenModeChange}>
              {PEN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Edit Segmentation
            <select value={drawAction} onChange={handleDrawActionChange}>
              <option value="">Select action</option>
              {DRAW_ACTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Drag Mode
            <select value={dragMode} onChange={handleDragModeChange}>
              {DRAG_MODE_OPTIONS.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={handleDiagnosticsClick}>
            Diagnostics
          </button>
          <button type="button" onClick={handleAboutClick}>
            About
          </button>
          </div>
        </div>
        {modelWarning && (
          <div className="toolbar-warning" dangerouslySetInnerHTML={{ __html: modelWarning }} />
        )}
      </header>
      <main className="viewer">
        <canvas ref={canvasRef} className="viewer-canvas" />
        {(!isVolumeReady || isRunning) && (
          <div className="viewer-overlay">
            <div className="viewer-status">
              {!isVolumeReady ? 'Drag and drop a NIfTI file (.nii or .nii.gz) or use the file input above' : 'Running segmentation…'}
            </div>
          </div>
        )}
      </main>
      <footer className="status-bar">
        <div className="status-location">
          {locationLines.map((line, index) => (
            <p key={`${line}-${index}`}>{line}</p>
          ))}
        </div>
        <progress value={progress} max="100" aria-label="Model progress" />
        <div
          className="status-memory"
          style={{ color: memoryStatus.color }}
          role="status"
          aria-live="polite"
        >
          {memoryStatus.text}
        </div>
        <a
          className="github-star"
          href="https://github.com/tuttucodes/3d-Mri-Viewer"
          target="_blank"
          rel="noreferrer"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
            className="github-icon"
          >
            <path
              fill="currentColor"
              d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.19 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8"
            />
          </svg>
          <span>Star</span>
          <span className="github-count">{starCount}</span>
        </a>
      </footer>
    </div>
  )
}

